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
        return new Response('{"id":"attached","status":"queued"}', {
            status: 202,
        });
    });
    const bytes = new Uint8Array([0, 1, 255]);
    const files = [attachment("invoice.pdf", bytes, "application/pdf")];
    const email = new Sendery("key").prepare({
        to: "a@example.com",
        template: "receipt",
        data: {},
        attachments: files,
    });
    bytes[0] = 99;
    files[0].content = "changed";
    await email.send();
    await email.send();
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(JSON.parse(calls[0].body).attachments[0].content, "AAH/");
    const limit = attachment("large.pdf", new Uint8Array(5242880));
    assert.doesNotThrow(() =>
        new Sendery("key").prepare({
            to: "a@example.com",
            template: "receipt",
            data: {},
            attachments: [limit],
        }),
    );
    assert.throws(() =>
        new Sendery("key").prepare({
            to: "a@example.com",
            template: "receipt",
            data: {},
            attachments: [limit, attachment("extra.txt", new Uint8Array([1]))],
        }),
    );
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

test("event retries preserve nested data and use the event endpoints", async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        calls.push({ url, options });
        if (options.method === "GET") {
            return Response.json({
                id: "event",
                status: "accepted",
                name: "listing.created",
                received_at: "2026-11-21T00:00:00+00:00",
                environment: "sandbox",
                matched_workflows: 1,
                runs: [
                    {
                        id: "run",
                        workflow_id: 4,
                        status: "completed",
                        due_at: null,
                        error_code: null,
                        actions: [
                            {
                                position: 0,
                                type: "condition",
                                status: "completed",
                                email_id: null,
                            },
                        ],
                    },
                ],
            });
        }
        return calls.length === 1
            ? new Response('{"code":"server_error"}', {
                  status: 503,
                  headers: { "Retry-After": "0" },
              })
            : new Response(
                  '{"id":"event","status":"accepted","matched_workflows":2}',
                  { status: 202 },
              );
    });
    const client = new Sendery("key");
    const input = {
        name: "listing.created",
        language: "ja",
        object: { type: "listing", id: "42" },
        data: { owner: { email: "steven@example.com" } },
    };
    const event = client.event(input);
    input.data.owner.email = "changed@example.com";
    assert.equal((await event.retry().send()).matched_workflows, 2);
    assert.equal(calls[0].url, "https://sendery.co/api/v1/events");
    assert.equal(calls[0].options.body, calls[1].options.body);
    assert.equal(
        calls[0].options.headers["Idempotency-Key"],
        calls[1].options.headers["Idempotency-Key"],
    );
    assert.equal(
        JSON.parse(calls[0].options.body).data.owner.email,
        "steven@example.com",
    );
    assert.equal(JSON.parse(calls[0].options.body).language, "ja");
    const result = await client.getEvent("event/id");
    assert.equal(result.name, "listing.created");
    assert.equal(result.received_at, "2026-11-21T00:00:00+00:00");
    assert.equal(result.runs[0].actions[0].type, "condition");
    assert.equal(calls[2].url, "https://sendery.co/api/v1/events/event%2Fid");
    await client.forgetObject("listing", "42");
    assert.equal(calls[3].options.method, "DELETE");
});

test("event definitions validate catalog responses without weakening email receipts", async () => {
    const client = new Sendery("test");
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return Response.json(
            options.method === "PUT"
                ? { name: "document.signed", verified: false }
                : { events: [] },
        );
    };
    assert.equal(
        (
            await client.defineEvent("document.signed", {
                label: "Document signed",
                object: { type: "document", label: "Document" },
                fields: {
                    email: { label: "Email", path: "email", type: "email" },
                },
            })
        ).verified,
        false,
    );
    assert.equal(calls[0].options.method, "PUT");
    assert.equal(
        calls[0].url,
        "https://sendery.co/api/v1/event-types/document.signed",
    );
    assert.deepEqual(await client.getEventTypes(), []);
    await assert.rejects(
        client.get("email"),
        (error) => error.code === "invalid_response",
    );
});

test("renders without delivery and preserves sandbox credentials", async (t) => {
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url, "https://sendery.co/api/v1/emails/render");
        assert.equal(options.headers.Authorization, "Bearer snd_sandbox_test");
        assert.equal(options.headers["Idempotency-Key"], undefined);
        assert.deepEqual(JSON.parse(options.body), {
            template: "welcome",
            data: { name: "Steven" },
            locale: "ja",
            version: 2,
        });
        return Response.json({
            subject: "Hello",
            html: "<p>Hello</p>",
            text: "Hello",
        });
    });
    assert.equal(
        (
            await new Sendery("snd_sandbox_test").render({
                template: "welcome",
                data: { name: "Steven" },
                locale: "ja",
                version: 2,
            })
        ).text,
        "Hello",
    );
});

test("render rejects incomplete content and reports quota errors", async (t) => {
    const mock = t.mock.method(globalThis, "fetch", async () =>
        Response.json({ html: "body" }),
    );
    const client = new Sendery("key");
    await assert.rejects(
        client.render({ template: "welcome", data: {} }),
        (e) => e.code === "invalid_response",
    );
    mock.mock.mockImplementation(async () =>
        Response.json({ code: "render_limit_exceeded" }, { status: 429 }),
    );
    await assert.rejects(
        client.render({ template: "welcome", data: {} }),
        (e) => e.code === "render_limit_exceeded" && !e.retryable,
    );
});
