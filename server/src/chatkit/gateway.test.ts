import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createAiDmApp } from "../app.js";
import { createChatKitGateway, type ChatKitGatewayOptions } from "./gateway.js";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";

const identity = { worldId: "world", userId: "gm", isGm: true } as AiDmAuthenticatedIdentity;
function fixture(overrides: Partial<ChatKitGatewayOptions> = {}) {
  const handler = createChatKitGateway({
    sidecarUrl: "http://127.0.0.1:3941",
    internalSecret: "internal-secret",
    allowedOrigins: ["http://localhost:30000"],
    authenticate: () => identity,
    authorize: () => Promise.resolve(),
    resolveAuthorization: () => Promise.resolve({ apiKey: "server-secret", model: "test-model" }),
    fetch: () =>
      Promise.resolve(
        new Response('data: {"type":"thread.item.updated"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ...overrides,
  });
  return createAiDmApp({
    chatkitHandler: handler,
    readiness: () => ({ ready: true, details: {} }),
  });
}
void describe("ChatKit gateway (mock sidecar)", () => {
  void it("native confirmation endpoint authenticates and verifies current GM without model credentials or provider calls", async () => {
    let called = 0;
    const app = fixture({
      resolveAuthorization: () => {
        throw new Error("Must not obtain billable credentials");
      },
      fetch: () => {
        throw new Error("Must not invoke sidecar/model");
      },
      nativeActions: (principal, body) => {
        assert.equal(principal.worldId, "world");
        assert.deepEqual(body, { threadId: "thread" });
        called++;
        return Promise.resolve([]);
      },
    });
    assert.equal(
      (await request(app).post("/chatkit/actions").send({ threadId: "thread" })).status,
      200,
    );
    assert.equal(called, 1);
    assert.equal(
      (
        await request(
          fixture({
            authorize: () => Promise.reject(new Error("revoked")),
            nativeActions: () => {
              called++;
              return Promise.resolve([]);
            },
          }),
        )
          .post("/chatkit/actions")
          .send({ threadId: "thread" })
      ).status,
      403,
    );
    assert.equal(called, 1);
    assert.equal(
      (
        await request(app)
          .post("/chatkit/actions")
          .set("Origin", "http://evil.invalid")
          .send({ threadId: "thread" })
      ).status,
      403,
    );
    assert.equal(called, 1);
  });
  void it("rejects expired sessions and players before resolving credentials", async () => {
    let called = false;
    const credentials = () => {
      called = true;
      return Promise.resolve({ apiKey: "secret", model: "test" });
    };
    assert.equal(
      (
        await request(
          fixture({
            authenticate: () => {
              throw new Error("expired");
            },
            resolveAuthorization: credentials,
          }),
        )
          .post("/chatkit")
          .send({})
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          fixture({
            authenticate: () => ({ ...identity, isGm: false }),
            resolveAuthorization: credentials,
          }),
        )
          .post("/chatkit")
          .send({})
      ).status,
      403,
    );
    assert.equal(called, false);
  });
  void it("preserves native SSE and confines credentials to authenticated loopback", async () => {
    let body = "";
    const app = fixture({
      fetch: (url, init) => {
        assert.ok(url instanceof URL);
        assert.equal(url.href, "http://127.0.0.1:3941/chatkit");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-chatkit-api-key"), "server-secret");
        assert.equal(
          (
            JSON.parse(Buffer.from(headers.get("x-chatkit-principal")!, "base64").toString()) as {
              userId: string;
            }
          ).userId,
          "gm",
        );
        assert.equal(typeof init?.body, "string");
        body = init?.body as string;
        return Promise.resolve(
          new Response('data: {"type":"thread.item.updated"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });
    const response = await request(app)
      .post("/chatkit")
      .send({ type: "threads.create", params: {} });
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"] ?? "", /text\/event-stream/);
    assert.equal((JSON.parse(body) as { type: string }).type, "threads.create");
    assert.doesNotMatch(response.text, /server-secret|internal-secret/);
  });
  void it("checks current GM authorization and origin; preflight does not request credentials", async () => {
    assert.equal(
      (
        await request(
          fixture({
            authorize: () => Promise.reject(new Error("role changed")),
          }),
        )
          .post("/chatkit")
          .send({})
      ).status,
      403,
    );
    assert.equal(
      (await request(fixture()).post("/chatkit").set("Origin", "http://evil.example").send({}))
        .status,
      403,
    );
    assert.equal(
      (await request(fixture()).options("/chatkit").set("Origin", "http://localhost:30000")).status,
      204,
    );
  });
  void it("reports unavailable service without leaking errors", async () => {
    const response = await request(
      fixture({
        fetch: () => Promise.reject(new Error("server-secret")),
      }),
    )
      .post("/chatkit")
      .send({});
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.text, /server-secret/);
  });
  void it("permits the observed official ChatKit frame header on browser preflight", async () => {
    const response = await request(fixture())
      .options("/chatkit")
      .set("Origin", "http://localhost:30000")
      .set("Access-Control-Request-Method", "POST")
      .set(
        "Access-Control-Request-Headers",
        "chatkit-frame-instance-id,content-type,x-ai-dm-browser-session,x-ai-dm-client,x-ai-dm-session,x-ai-dm-version",
      );
    assert.equal(response.status, 204);
    const allowed = (response.headers["access-control-allow-headers"] as string)
      .split(",")
      .map((value) => value.trim());
    assert.ok(allowed.includes("chatkit-frame-instance-id"));
    assert.equal(response.headers["access-control-allow-origin"], "http://localhost:30000");
    assert.equal(allowed.includes("*"), false);
    const forbidden = await request(fixture())
      .options("/chatkit")
      .set("Origin", "http://evil.example");
    assert.equal(forbidden.status, 403);
  });
});

void describe("ChatKit bridge lifecycle (mock sidecar, real HTTP)", () => {
  void it("issues capability only internally and releases after streamed response", async () => {
    let releases = 0;
    const app = fixture({
      beginReadRun: (_identity, body, signal) => {
        assert.equal((body as { type: string }).type, "threads.create");
        assert.equal(signal.aborted, false);
        return {
          token: "internal-capability",
          release: () => {
            releases++;
          },
        };
      },
      fetch: (_url, init) => {
        assert.equal(new Headers(init?.headers).get("x-chatkit-read-run"), "internal-capability");
        return Promise.resolve(
          new Response("data: first\n\n", { headers: { "content-type": "text/event-stream" } }),
        );
      },
    });
    const result = await request(app).post("/chatkit").send({ type: "threads.create", params: {} });
    assert.equal(result.status, 200);
    assert.equal(releases, 1);
    assert.doesNotMatch(result.text, /internal-capability/);
  });
  void it("does not forward a chunk after live GM authorization is revoked", async () => {
    let authorizations = 0;
    const app = fixture({
      authorize: async () => {
        await Promise.resolve();
        if (++authorizations > 1) throw new Error("revoked");
      },
    });
    const result = await request(app).post("/chatkit").send({ type: "threads.create", params: {} });
    assert.doesNotMatch(result.text, /thread.item.updated/);
  });
  void it("bounds unresponsive headers and stalled stream; releases capabilities", async () => {
    let releases = 0;
    for (const fetch of [
      () => new Promise<Response>(() => {}),
      () =>
        Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    ]) {
      const app = fixture({
        timeoutMs: 30,
        runTimeoutMs: 60,
        fetch,
        beginReadRun: () => ({
          token: "cap",
          release: () => {
            releases++;
          },
        }),
      });
      const result = await request(app)
        .post("/chatkit")
        .send({ type: "threads.create", params: {} });
      assert.equal(result.status, 504);
    }
    assert.equal(releases, 2);
  });
  void it("closes a stream that stalls after its first chunk and cancels the run capability", async () => {
    let releases = 0;
    let cancelled = false;
    let runSignal: AbortSignal | undefined;
    const app = fixture({
      runTimeoutMs: 40,
      beginReadRun: (_identity, _body, signal) => {
        runSignal = signal;
        return {
          token: "cap",
          release: () => {
            releases++;
          },
        };
      },
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    });
    const result = await request(app)
      .post("/chatkit")
      .send({ type: "threads.create", params: {} })
      .timeout({ deadline: 500 });
    assert.equal(result.status, 200);
    assert.equal(result.text, "data: first\n\n");
    assert.equal(cancelled, true);
    assert.equal(runSignal?.aborted, true);
    assert.equal(releases, 1);
  });
});
