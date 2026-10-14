import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createAiDmApp } from "../app.js";
import { createChatKitGateway } from "./gateway.js";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";

void test("explicit player receipt ingress keeps live authorization and skips model credential resolution", async () => {
  let authorized = 0, runs = 0, proxied = 0;
  const app = createAiDmApp({readiness: () => ({ready: true, details: {}}), chatkitHandler: createChatKitGateway({
    sidecarUrl: "http://127.0.0.1:3941", internalSecret: "fixture", allowedOrigins: [],
    authenticate: () => ({worldId: "world", userId: "gm", isGm: true}) as AiDmAuthenticatedIdentity,
    authorize: async () => { authorized++; },
    resolveAuthorization: async () => { throw new Error("No model credential allowed"); },
    beginReadRun: () => {runs++; return {token: "fixture-run", release() {}};},
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-chatkit-api-key"), "");
      assert.equal(headers.get("x-chatkit-model"), "");
      assert.equal(headers.get("x-chatkit-read-run"), "fixture-run");
      proxied++;
      return new Response("data: {}\n\n", {headers: {"content-type": "text/event-stream"}});
    },
  })});
  const result = await request(app).post("/chatkit").send({type: "threads.custom_action", params: {
    thread_id: "safe-thread", action: {type: "foundry.player-observation", payload: {
      requestId: "receipt", worldId: "world", sceneId: "scene", userId: "player", clientId: "client", tokenId: "token",
    }},
  }});
  assert.equal(result.status, 200);
  assert.ok(authorized >= 2);
  assert.equal(runs, 1);
  assert.equal(proxied, 1);
});
