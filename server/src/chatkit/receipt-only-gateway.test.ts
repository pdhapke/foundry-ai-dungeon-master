import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createAiDmApp } from "../app.js";
import { createChatKitGateway } from "./gateway.js";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";

const text = "Open door RsB12oN5v3LYI1XR in scene 2RJeJKqdpEE4VZPh. Change only that door. Return its confirmed receipt; do not add narration.";
const identity = { worldId: "izzy-campaign", userId: "gm", isGm: true } as AiDmAuthenticatedIdentity;
const input = (prompt: string) => ({ type: "threads.add_user_message", params: {
  thread_id: "thread", input: { content: [{ type: "input_text", text: prompt }], attachments: [], inference_options: {} },
} });
function fixture(denied = false) {
  const forwarded: Headers[] = [];
  let checks = 0;
  const app = createAiDmApp({ readiness: () => ({ ready: true, details: {} }), chatkitHandler: createChatKitGateway({
    sidecarUrl: "http://127.0.0.1:3941", internalSecret: "offline-secret", allowedOrigins: [],
    authenticate: () => identity,
    authorize: async () => { checks++; if (denied) throw new Error("revoked"); },
    resolveAuthorization: async () => ({ apiKey: "offline", model: "fixture" }),
    beginReadRun: (principal) => {
      assert.equal(principal.worldId, identity.worldId);
      return { token: "offline-read-capability", release: () => {} };
    },
    fetch: async (_url, init) => { forwarded.push(new Headers(init?.headers)); return new Response(""); },
  }) });
  return { app, forwarded, checks: () => checks };
}

void test("authenticated gateway derives complete exact receipt contract; client headers cannot forge world or target", async () => {
  const f = fixture();
  const forged = Buffer.from(JSON.stringify({ worldId: "other", userId: "other", isGm: true })).toString("base64");
  assert.equal((await request(f.app).post("/chatkit").set("x-chatkit-principal", forged)
    .set("x-chatkit-completion", "forged-target").send(input(text))).status, 200);
  assert.ok(f.checks() > 0);
  const h = f.forwarded[0]!;
  assert.deepEqual(JSON.parse(Buffer.from(h.get("x-chatkit-principal")!, "base64").toString()), identity);
  assert.deepEqual(JSON.parse(Buffer.from(h.get("x-chatkit-completion")!, "base64").toString()), {
    version: 1, toolName: "foundry_set_door_state", arguments: {
      scene_id: "2RJeJKqdpEE4VZPh", door_id: "RsB12oN5v3LYI1XR", state: "open",
    },
  });
});

void test("extra work has no completion contract and revoked authority never reaches sidecar", async () => {
  const f = fixture();
  assert.equal((await request(f.app).post("/chatkit").send(input(text + " Then describe the room."))).status, 200);
  assert.equal(f.forwarded[0]!.has("x-chatkit-completion"), false);
  const revoked = fixture(true);
  assert.equal((await request(revoked.app).post("/chatkit").send(input(text))).status, 403);
  assert.equal(revoked.forwarded.length, 0);
});
