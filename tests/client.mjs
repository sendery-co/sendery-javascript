import { test } from "node:test";
import assert from "node:assert/strict";
import { Sendery, SenderyError } from "../dist/index.js";

test("freezes the payload and retries with the same generated key", async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
            ? new Response('{"code":"server_error"}', {
                  status: 503,
                  headers: { "Retry-After": "0" },
              })
            : new Response('{"id":"msg","status":"queued"}', { status: 202 });
    });
    const input = {
        to: "a@example.com",
        template: "welcome",
        data: { name: "Original" },
    };
    const email = new Sendery("key").prepare(input);
    input.data.name = "Changed";
    assert.equal((await email.retry().send()).id, "msg");
    assert.equal(calls[0].options.body, calls[1].options.body);
    assert.equal(
        calls[0].options.headers["Idempotency-Key"],
        email.idempotencyKey,
    );
    assert.equal(
        calls[1].options.headers["Idempotency-Key"],
        email.idempotencyKey,
    );
    assert.equal(JSON.parse(calls[0].options.body).data.name, "Original");
});

test("quota, validation, and redirects never retry", async (t) => {
    for (const [status, code] of [
        [429, "email_capacity_exceeded"],
        [422, "validation_error"],
        [302, "request_error"],
    ]) {
        let calls = 0;
        const mock = t.mock.method(globalThis, "fetch", async () => {
            calls++;
            return new Response(JSON.stringify({ code }), { status });
        });
        await assert.rejects(
            new Sendery("key")
                .prepare({ to: "a@example.com", template: "welcome", data: {} })
                .retry()
                .send(),
            SenderyError,
        );
        assert.equal(calls, 1);
        mock.mock.restore();
    }
});

test("get retrieves message status and omits idempotency header", async (t) => {
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url, "https://sendery.co/api/v1/emails/msg");
        assert.equal(options.method, "GET");
        assert.equal(options.headers["Idempotency-Key"], undefined);
        return new Response('{"id":"msg","status":"delivered"}');
    });
    assert.equal((await new Sendery("key").get("msg")).status, "delivered");
});
