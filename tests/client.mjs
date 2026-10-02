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
    const email = new Sendery("key").prepare(input).version(3);
    input.data.name = "Changed";
    assert.equal((await email.retry().send()).id, "msg");
    assert.equal(calls[0].options.body, calls[1].options.body);
    assert.equal(JSON.parse(calls[0].options.body).version, 3);
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

test("attachments freeze with retries and enforce the combined limit", async (t) => {
    const { attachment } = await import("../dist/index.js");
    const calls = [];
    t.mock.method(globalThis, "fetch", async (_, options) => {
        calls.push(options);
        return new Response('{"id":"attached","status":"queued"}', { status: 202 });
    });
    const bytes = new Uint8Array([0, 1, 255]);
    const files = [attachment("invoice.pdf", bytes, "application/pdf")];
    const email = new Sendery("key").prepare({to: "a@example.com", template: "receipt", data: {}, attachments: files});
    bytes[0] = 99;
    files[0].content = "changed";
    await email.send(); await email.send();
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(JSON.parse(calls[0].body).attachments[0].content, "AAH/");
    const limit = attachment("large.pdf", new Uint8Array(5242880));
    assert.doesNotThrow(() => new Sendery("key").prepare({to: "a@example.com", template: "receipt", data: {}, attachments: [limit]}));
    assert.throws(() => new Sendery("key").prepare({to: "a@example.com", template: "receipt", data: {}, attachments: [limit, attachment("extra.txt", new Uint8Array([1]))]}));
});

test("version is optional and rejects invalid integers", async (t) => {
    const bodies = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return new Response('{"id":"msg","status":"queued"}', { status: 202 });
    });
    const client = new Sendery("key");
    const input = { to: "a@example.com", template: "welcome", data: {} };
    await client.send(input);
    await client.send({ ...input, version: 2 });
    assert.equal("version" in bodies[0], false);
    assert.equal(bodies[1].version, 2);
    for (const value of [0, -1, 1.5, NaN, Infinity, "3", null, true]) {
        assert.throws(() => client.prepare(input).version(value));
        assert.throws(() => client.prepare({ ...input, version: value }));
    }
});
