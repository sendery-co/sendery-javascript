export type Variables = Record<
    string,
    string | number | boolean | Record<string, string | number | boolean>[]
>;
export interface Attachment {
    filename: string;
    /** Standard base64 file content, without a data URL prefix. */
    content: string;
    content_type?: string;
}
export function attachment(filename: string, bytes: Uint8Array, contentType = "application/octet-stream"): Attachment {
    if (!bytes.length || bytes.length > 5 * 1024 * 1024)
        throw new Error("Attachments must contain 1 to 5,242,880 bytes.");
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { filename, content: btoa(binary), content_type: contentType };
}
export interface SendEmailInput {
    to: string;
    template: string;
    data: Variables;
    locale?: string;
    attachments?: Attachment[];
}
export interface SendReceipt {
    id: string;
    status: string;
    error_code?: string | null;
    created_at?: string;
    submitted_at?: string | null;
}
export class SenderyError extends Error {
    status: number;
    code: string;
    errors: Record<string, string[]>;
    retryAfter?: number;
    constructor(
        status: number,
        code = "request_error",
        errors: Record<string, string[]> = {},
        retryAfter?: number,
    ) {
        super(`Sendery API error: ${code}`);
        this.name = "SenderyError";
        this.status = status;
        this.code = code;
        this.errors = errors;
        this.retryAfter = retryAfter;
    }
    get retryable(): boolean {
        return (
            [0, 500, 502, 503, 504].includes(this.status) ||
            (this.status === 429 && this.code === "rate_limited")
        );
    }
}
export class PendingEmail {
    readonly idempotencyKey: string;
    private readonly body: string;
    private readonly client: Sendery;
    private retries = 0;
    constructor(client: Sendery, input: SendEmailInput, key: string) {
        if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key))
            throw new Error("Invalid idempotency key.");
        const files = input.attachments ?? [];
        const size = files.reduce((sum, file) => {
            if (!file.content.length || file.content.length > 6990508 || (file.content.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(file.content.replace(/={1,2}$/, ""))))
                throw new Error("Provide standard base64 attachment content.");
            return sum + (file.content.length / 4) * 3 - (file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0);
        }, 0);
        if (files.length > 10 || size > 5 * 1024 * 1024)
            throw new Error("Use at most 10 attachments, up to 5 MB combined.");
        this.client = client;
        this.idempotencyKey = key;
        this.body = JSON.stringify({
            to: input.to,
            template: input.template,
            data: input.data,
            ...(input.locale ? { locale: input.locale } : {}),
            ...(files.length ? { attachments: files } : {}),
        });
    }
    retry(retries = 3): this {
        if (!Number.isInteger(retries) || retries < 0 || retries > 5)
            throw new Error("Choose 0 to 5 retries.");
        this.retries = retries;
        return this;
    }
    async send(): Promise<SendReceipt> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.client.request(
                    "POST",
                    "/api/v1/emails",
                    this.body,
                    this.idempotencyKey,
                );
            } catch (error) {
                if (
                    !(error instanceof SenderyError) ||
                    !error.retryable ||
                    attempt >= this.retries
                )
                    throw error;
                const delay =
                    error.retryAfter ??
                    Math.min(8, 0.25 * 2 ** attempt + Math.random() * 0.1);
                if (delay > 30) throw error;
                await new Promise((resolve) =>
                    setTimeout(resolve, delay * 1000),
                );
            }
        }
    }
}
export class Sendery {
    private apiKey: string;
    private baseUrl: string;
    constructor(apiKey: string, baseUrl = "https://sendery.co") {
        if (typeof window !== "undefined")
            throw new Error("Sendery API keys must remain on the server.");
        const url = new URL(baseUrl);
        if (
            !apiKey ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.protocol !== "https:" &&
                !(
                    url.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
                ))
        )
            throw new Error(
                "Provide an API key and an HTTPS URL (HTTP allowed only on loopback).",
            );
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }
    prepare(
        input: SendEmailInput,
        idempotencyKey: string = crypto.randomUUID(),
    ): PendingEmail {
        return new PendingEmail(this, input, idempotencyKey);
    }
    send(input: SendEmailInput, idempotencyKey?: string): Promise<SendReceipt> {
        return this.prepare(input, idempotencyKey).send();
    }
    get(id: string): Promise<SendReceipt> {
        return this.request("GET", `/api/v1/emails/${encodeURIComponent(id)}`);
    }
    async request(
        method: string,
        path: string,
        body?: string,
        key?: string,
    ): Promise<SendReceipt> {
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                method,
                redirect: "error",
                signal: AbortSignal.timeout(10_000),
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    ...(key ? { "Idempotency-Key": key } : {}),
                },
                body,
            });
        } catch {
            throw new SenderyError(0, "connection_error");
        }
        const parsed = await response.json().catch(() => ({}));
        const data =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : {};
        if (!response.ok) {
            const header = response.headers.get("Retry-After");
            const seconds =
                header === null
                    ? undefined
                    : /^\d+(\.\d+)?$/.test(header)
                      ? Number(header)
                      : (Date.parse(header) - Date.now()) / 1000;
            throw new SenderyError(
                response.status,
                data.code,
                data.errors,
                seconds !== undefined && Number.isFinite(seconds)
                    ? Math.max(0, seconds)
                    : undefined,
            );
        }
        if (typeof data.id !== "string" || typeof data.status !== "string")
            throw new SenderyError(0, "invalid_response");
        return data;
    }
}
