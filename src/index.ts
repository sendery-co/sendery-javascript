export interface EventField {
    label: string;
    path: string;
    type: "text" | "number" | "boolean" | "email" | "url" | "date" | "rows";
    required?: boolean;
    /** Use synthetic examples, never customer information. */
    example?:
        string | number | boolean | Record<string, string | number | boolean>[];
}
export interface EventDefinition {
    label: string;
    object: { type: string; label: string };
    fields: Record<string, EventField>;
    recipients: Record<
        string,
        { label: string; email: string; name?: string; locale?: string }
    >;
}
export interface EventType extends EventDefinition {
    name: string;
    verified: boolean;
    last_received_at: string | null;
}
export interface EventTypeReceipt {
    name: string;
    verified: boolean;
}
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
export function attachment(
    filename: string,
    bytes: Uint8Array,
    contentType = "application/octet-stream",
): Attachment {
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
    version?: number;
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
export interface EventInput {
    name: string;
    object: { type: string; id: string };
    correlation_id?: string;
    data: Record<string, unknown>;
}
export interface EventReceipt extends SendReceipt {
    name?: string;
    received_at?: string;
    matched_triggers?: number;
    environment?: "sandbox" | "live";
    runs?: {
        id: string;
        trigger_id: number;
        status: string;
        due_at: string | null;
        error_code: string | null;
        actions: {
            position: number;
            type: string;
            status: string;
            email_id: string | null;
        }[];
    }[];
}
class PendingRequest<T extends SendReceipt> {
    readonly idempotencyKey: string;
    protected body: string;
    private retries = 0;
    private client: Sendery;
    private endpoint: string;
    constructor(
        client: Sendery,
        input: unknown,
        key: string,
        endpoint: string,
    ) {
        if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key))
            throw new Error("Invalid idempotency key.");
        this.idempotencyKey = key;
        this.client = client;
        this.endpoint = endpoint;
        this.body = JSON.stringify(input);
    }
    retry(retries = 3): this {
        if (!Number.isInteger(retries) || retries < 0 || retries > 5)
            throw new Error("Choose 0 to 5 retries.");
        this.retries = retries;
        return this;
    }
    async send(): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.client.request<T>(
                    "POST",
                    this.endpoint,
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
export class PendingEvent extends PendingRequest<EventReceipt> {
    constructor(client: Sendery, input: EventInput, key: string) {
        super(client, input, key, "/api/v1/events");
    }
}
export class PendingEmail extends PendingRequest<SendReceipt> {
    constructor(client: Sendery, input: SendEmailInput, key: string) {
        const files = input.attachments ?? [];
        const size = files.reduce((sum, file) => {
            if (
                !file.content.length ||
                file.content.length > 6990508 ||
                file.content.length % 4 !== 0 ||
                /[^A-Za-z0-9+/]/.test(file.content.replace(/={1,2}$/, ""))
            )
                throw new Error("Provide standard base64 attachment content.");
            return (
                sum +
                (file.content.length / 4) * 3 -
                (file.content.endsWith("==")
                    ? 2
                    : file.content.endsWith("=")
                      ? 1
                      : 0)
            );
        }, 0);
        if (files.length > 10 || size > 5 * 1024 * 1024)
            throw new Error("Use at most 10 attachments, up to 5 MB combined.");
        super(
            client,
            {
                to: input.to,
                template: input.template,
                data: input.data,
                ...(input.locale ? { locale: input.locale } : {}),
                ...(files.length ? { attachments: files } : {}),
            },
            key,
            "/api/v1/emails",
        );
        if (input.version !== undefined) this.version(input.version);
    }
    version(version: number): this {
        if (!Number.isSafeInteger(version) || version < 1)
            throw new Error("Version must be a positive integer.");
        this.body = JSON.stringify({ ...JSON.parse(this.body), version });
        return this;
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
    defineEvent(
        name: string,
        definition: EventDefinition,
    ): Promise<EventTypeReceipt> {
        return this.request(
            "PUT",
            `/api/v1/event-types/${encodeURIComponent(name)}`,
            JSON.stringify(definition),
        );
    }
    async getEventTypes(): Promise<EventType[]> {
        return (
            await this.request<{ events: EventType[] }>(
                "GET",
                "/api/v1/event-types",
            )
        ).events;
    }
    event(
        input: EventInput,
        idempotencyKey: string = crypto.randomUUID(),
    ): PendingEvent {
        return new PendingEvent(this, input, idempotencyKey);
    }
    getEvent(id: string): Promise<EventReceipt> {
        return this.request<EventReceipt>(
            "GET",
            `/api/v1/events/${encodeURIComponent(id)}`,
        );
    }
    forgetObject(type: string, id: string): Promise<SendReceipt> {
        return this.request(
            "DELETE",
            "/api/v1/event-objects",
            JSON.stringify({ type, id }),
        );
    }
    get(id: string): Promise<SendReceipt> {
        return this.request("GET", `/api/v1/emails/${encodeURIComponent(id)}`);
    }
    async request<T = SendReceipt>(
        method: string,
        path: string,
        body?: string,
        key?: string,
    ): Promise<T> {
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
        const valid =
            path === "/api/v1/event-types"
                ? Array.isArray(data.events)
                : path.startsWith("/api/v1/event-types/")
                  ? typeof data.name === "string" &&
                    typeof data.verified === "boolean"
                  : typeof data.id === "string" &&
                    typeof data.status === "string";
        if (!valid) throw new SenderyError(0, "invalid_response");
        return data;
    }
}
