import assert from "node:assert/strict";
import test from "node:test";
import express, { type RequestHandler } from "express";
import request from "supertest";
import type { ApiExtensionContext, EventSender } from "./api-contract.js";
import { registerExtension } from "./extension.js";

void test("AI-owned extension registers semantics and private channel but defaults inactive without commands or tunnel startup", async t => {
  const original = process.env["FOUNDRY_DOT_CONFIG"]; delete process.env["FOUNDRY_DOT_CONFIG"];
  t.after(() => { if (original === undefined) delete process.env["FOUNDRY_DOT_CONFIG"]; else process.env["FOUNDRY_DOT_CONFIG"] = original; });
  const routes = new Map<string, RequestHandler>(), events = new Map<string, (payload: unknown, sender: EventSender) => void | Promise<void>>();
  const privateChannels = new Map<string, (payload: unknown, sender: EventSender, current: () => boolean) => Promise<void>>();
  const shutdowns: (() => void | Promise<void>)[] = [];
  let calls = 0, sends = 0;
  const noop = () => undefined;
  const context: ApiExtensionContext = {
    version: 1, moduleRoot: new URL("file:///C:/synthetic/api/"), runtimeRoot: new URL("file:///C:/synthetic/api/.runtime/"), bindHost: "127.0.0.1", administrativeCredentialSha256: "0".repeat(64),
    bridge: { getClient: () => null, getVerifiedFoundryIdentity: () => null, send: () => { sends++; return false; } },
    call: () => { calls++; return Promise.reject(new Error("An inactive extension must not invoke Foundry.")); },
    registerPrivateChannel: (name, handler) => { privateChannels.set(name, handler); return noop; },
    registerEventHandler: (name, handler) => { events.set(name, handler); return noop; },
    onConnectionEstablished: () => noop, onConnectionLost: () => noop,
    registerRoute: (path, handler) => { routes.set(path, handler); return noop; },
    onShutdown: handler => { shutdowns.push(handler); return noop; },
  };
  registerExtension(context);
  assert.deepEqual([...privateChannels.keys()], ["dot-tunnel-configuration"]);
  assert.deepEqual([...events.keys()].sort(), ["foundry.dot_controller_requested", "foundry.dot_tunnel_tool_setup", "foundry.player_turn_completed"]);
  assert.equal(calls, 0); assert.equal(sends, 0);
  const app = express(); app.use(routes.get("/dot/mcp")!);
  await request(app).post("/dot/mcp").send({ runtimeKey: "synthetic-secret-must-not-be-logged" }).expect(503);
  await request(app).get("/dot/mcp").expect(405);
  await events.get("foundry.player_turn_completed")!({}, { clientId: "forged", userId: "player", lane: "player" });
  await privateChannels.get("dot-tunnel-configuration")!({ kind: "dot-tunnel-configuration", runtimeKey: "synthetic" }, { clientId: "forged", userId: "player", lane: "player" }, () => true);
  for (const handler of shutdowns) await Promise.resolve(handler());
  assert.equal(calls, 0); assert.equal(sends, 0);
});
