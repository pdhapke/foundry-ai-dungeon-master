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
