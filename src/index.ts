export type Variables = Record<
    string,
    string | number | boolean | Record<string, string | number | boolean>[]
>;
export interface SendEmailInput {
    to: string;
    template: string;
    data: Variables;
    locale?: string;
}
export interface SendReceipt {
    id: string;
    status: string;
}

export class SendaryError extends Error {
    public status: number;
    constructor(status: number) {
        super(`Sendary API returned HTTP ${status}`);
        this.name = "SendaryError";
        this.status = status;
    }
}

/** Server-side only. This package is local source until the SDK is published. */
export class Sendary {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey: string, baseUrl: string) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        if (typeof window !== "undefined")
            throw new Error("Sendary API keys must remain on the server.");
        const url = new URL(baseUrl);
        if (
            !apiKey ||
            (url.protocol !== "https:" &&
                !(
                    url.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
                ))
        ) {
            throw new Error(
                "Provide an API key and an HTTPS URL (HTTP allowed only on loopback).",
            );
        }
    }
    async send(
        input: SendEmailInput,
        idempotencyKey: string = crypto.randomUUID(),
    ): Promise<SendReceipt> {
        const response = await fetch(
            `${this.baseUrl.replace(/\/$/, "")}/api/v1/emails`,
            {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(10_000),
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "Idempotency-Key": idempotencyKey,
                },
                body: JSON.stringify({
                    to: input.to,
                    template: input.template,
                    data: input.data,
                    ...(input.locale ? { locale: input.locale } : {}),
                }),
            },
        );
        if (!response.ok) throw new SendaryError(response.status);
        return (await response.json()) as SendReceipt;
    }
}
