import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createDotRuntime, registerDotRuntime, type GenericBridgeApi } from "./dot-runtime.js";

function fixture(t: TestContext) {
  const saved = new Map(["game", "canvas", "Hooks", "localStorage"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const put = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  const storage = new Map<string, string>();
  const modules = new Map<string, { active?: boolean; api?: Record<string, unknown> }>([["foundry-ai-dungeon-master", { active: true, api: { open: () => undefined } }]]);
  const settings = new Map<string, unknown>([["dmEventMode", "dot"], ["automaticEventsEnabled", true]]);
  const hooks = new Map<string, ((...args: unknown[]) => void)[]>();
  const user = { id: "gm", isGM: true, active: true, name: "GM" };
  put("game", { user, world: { id: "world" }, modules, settings: { get: (id: string, key: string) => { assert.equal(id, "foundry-ai-dungeon-master"); return settings.get(key); } } });
  put("canvas", { scene: { id: "scene" } });
  put("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  put("Hooks", { on: (name: string, listener: (...args: unknown[]) => void) => { const list = hooks.get(name) ?? []; list.push(listener); hooks.set(name, list); } });
  return { modules, storage, user, settings, emit: (name: string, ...args: unknown[]) => { for (const callback of hooks.get(name) ?? []) callback(...args); } };
}
function bridge() {
  const identity = { clientId: "client", userId: "gm", lane: "gm", connected: false };
  const commands = new Map<string, (payload: unknown) => unknown>();
  const guards = new Map<string, (context: unknown) => void>();
  const messages = new Set<(payload: unknown) => boolean>();
  const statuses = new Set<(status: "disconnected" | "connecting" | "connected") => void>();
  const pumps = new Set<() => void>();
  const sent: { name: string; payload: unknown }[] = [];
  const api: GenericBridgeApi = {
    version: 1, identity: () => ({ ...identity }),
    registerCommand: (type, handler) => { if (commands.has(type)) throw new Error("duplicate"); commands.set(type, handler); return () => { commands.delete(type); }; },
    registerDocumentGuard: (name, handler) => { if (guards.has(name)) throw new Error("duplicate"); guards.set(name, handler); return () => { guards.delete(name); }; },
    sendEvent: (name, payload) => { sent.push({ name, payload }); }, sendPrivate: () => undefined,
    onMessage: listener => { messages.add(listener); return () => { messages.delete(listener); }; },
    onStatus: listener => { statuses.add(listener); return () => { statuses.delete(listener); }; },
    onPump: listener => { pumps.add(listener); return () => { pumps.delete(listener); }; },
  };
  return { api, identity, commands, guards, messages, statuses, pumps, sent, connect: () => { identity.connected = true; for (const callback of statuses) callback("connected"); } };
}
for (const order of ["api-first", "ai-first"] as const) {
  void test(`dot runtime starts exactly once with ${order} ready order and retains legacy browser state`, async t => {
    const f = fixture(t), b = bridge();
    if (order === "api-first") f.modules.set("foundry-local-api", { active: true, api: { bridge: b.api } });
    registerDotRuntime();
    f.emit("ready"); await Promise.resolve();
    if (order === "ai-first") { assert.equal(b.commands.size, 0); f.modules.set("foundry-local-api", { active: true, api: { bridge: b.api } }); f.emit("foundry-local-api.bridgeReady", b.api); }
    assert.equal(b.commands.size, 7); assert.equal(b.guards.size, 1); assert.equal(b.sent.length, 0);
    assert.ok(f.storage.has("foundry-local-api.dot.v1.gm.client"));
    assert.equal(typeof f.modules.get("foundry-ai-dungeon-master")?.api?.["open"], "function");
    assert.ok(f.modules.get("foundry-ai-dungeon-master")?.api?.["dotTunnelSetup"]);
    assert.equal(f.modules.get("foundry-local-api")?.api?.["dot"], undefined);
    b.connect(); assert.equal(b.sent[0]?.name, "foundry.dot_controller_requested");
    assert.deepEqual(b.commands.get("dotSetupReadiness")?.({}), { controller: { worldId: "world", sceneId: "scene", clientId: "client", userId: "gm" }, automaticEventsEnabled: true, dmEventMode: "dot" });
    f.emit("foundry-local-api.bridgeReady", b.api); assert.equal(b.commands.size, 7); assert.equal(b.statuses.size, 1);
    const replacement = bridge(); f.modules.get("foundry-local-api")!.api = { bridge: replacement.api }; f.emit("foundry-local-api.bridgeReady", replacement.api);
    assert.equal(b.commands.size, 0); assert.equal(b.guards.size, 0); assert.equal(b.statuses.size, 0); assert.equal(replacement.commands.size, 7); assert.equal(replacement.guards.size, 1);
    f.modules.delete("foundry-local-api"); f.emit("foundry-local-api.bridgeReady"); assert.equal(replacement.commands.size, 0); assert.equal(replacement.guards.size, 0); assert.equal(f.modules.get("foundry-ai-dungeon-master")?.api?.["dot"], undefined);
  });
}
void test("DM settings revoke the binding and current identity change refuses scoped commands", t => {
  const f = fixture(t), b = bridge(); b.identity.connected = true;
  const runtime = createDotRuntime(b.api); t.after(() => runtime.dispose());
  const binding = { worldId: "world", sceneId: "scene", sessionId: "session", controllerId: "controller", clientId: "client", userId: "gm" };
  b.commands.get("dotBind")!(binding); assert.ok(runtime.dot.getScope());
  b.identity.userId = "other"; assert.equal(runtime.dot.getScope(), undefined); assert.throws(() => b.commands.get("dotSetupScope")!({}), /GM scene/);
  b.identity.userId = "gm"; f.settings.set("automaticEventsEnabled", false); runtime.requestBinding(); assert.equal(runtime.dot.getScope(), undefined);
});
void test("partial extension registration cleans up and player lanes cannot initialize", t => {
  fixture(t); const b = bridge(); b.commands.set("dotRead", () => undefined);
  assert.throws(() => createDotRuntime(b.api), /initialize/); assert.deepEqual([...b.commands.keys()], ["dotRead"]);
  assert.equal(b.guards.size, 0);
  b.identity.lane = "player"; assert.throws(() => createDotRuntime(b.api), /current GM/); assert.equal(b.messages.size, 0);
});
void test("preparation policy attaches in embedded mode with automatic events disabled", t => {
  const f = fixture(t), b = bridge(); f.settings.set("dmEventMode", "embedded"); f.settings.set("automaticEventsEnabled", false);
  const runtime = createDotRuntime(b.api); t.after(() => runtime.dispose());
  assert.equal(b.guards.size, 1); assert.equal(b.sent.length, 0);
  const source = { active: false, flags: { "foundry-ai-dungeon-master": { preparationId: "a".repeat(64) } } };
  const context = { input: { family: "scene-tokens", operation: "create", parentId: "scene", targetId: "token", preparationGuard: { sceneId: "scene", preparationId: "a".repeat(64) } }, data: { hidden: true }, source };
  assert.doesNotThrow(() => b.guards.get("preparation")!(context));
  source.active = true; assert.throws(() => b.guards.get("preparation")!(context), /active/);
  runtime.dispose(); assert.equal(b.guards.size, 0);
});
