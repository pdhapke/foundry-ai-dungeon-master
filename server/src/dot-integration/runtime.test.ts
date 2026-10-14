/* Synthetic async mock adapters intentionally resolve synchronously. */
/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pathToFileURL } from "node:url";
import request from "supertest";
import express from "express";
import { DotIntegration, type DotIntegrationSetup, type DotBinding } from "./runtime.js";
import { MemoryEventStore, mountMcpEvents, type McpEventsHttpOptions } from "../../../../foundry-local-api/server/events-core.js";
import { completedTurnDefinition, completedTurnEventId, dotStateRevision, DOT_PROTOCOL_VERSION, type CompletedPlayerTurnInput, type DotStateRevisionInput } from "./contract.js";

// Dynamic URL keeps the server project's compile root unchanged; tests exercise
// the real browser implementation through the same public transport contract.
interface TestBrowser {
  setConnected(value: boolean): void;
  bind(raw: unknown): Record<string, unknown>;
  unbind(): void;
  getScope(): (DotBinding & { connected: boolean; isController: boolean; automaticEventsEnabled: boolean }) | undefined;
  read(combatId: string): Promise<Record<string, unknown>>;
  respond(raw: unknown): Promise<Record<string, unknown>>;
  receive(raw: unknown): boolean;
  submitCompletedTurn(input: CompletedPlayerTurnInput, signal: AbortSignal): Promise<void>;
}
interface TestNative {
  authority(binding: DotBinding): boolean;
  state(binding: DotBinding, combatId: string): { state: DotStateRevisionInput; playerCombatantIds: string[] } | undefined;
  findMessage(id: string): Record<string, unknown> | undefined;
  createMessage(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}
const browserModule = await import(process.env["FOUNDRY_DOT_TEST_MODULE"] ? pathToFileURL(process.env["FOUNDRY_DOT_TEST_MODULE"]).href : new URL("../../../module/src/dot-bridge.ts", import.meta.url).href) as unknown as {
  DotBridge: new (clientId: string, userId: string, disk: ReturnType<typeof storage>, native: TestNative, send: (event: string, payload: unknown) => void) => TestBrowser;
};
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }
async function fixture() {
  const enabled = true;
  let attest = true, connected = true, version = 123, writes = 0, loseWriteReceipt = false;
  let responseGate: Promise<void> | undefined, releaseResponse: (() => void) | undefined, responseQueued: (() => void) | undefined;
  let mutationGate: Promise<void> | undefined, releaseMutation: (() => void) | undefined, mutationStarted: (() => void) | undefined;
  let webhookGate: Promise<void> | undefined, releaseWebhook: (() => void) | undefined, webhookStarted: (() => void) | undefined;
  const messages = new Map<string, Record<string, unknown>>(), disk = storage(), store = new MemoryEventStore(completedTurnDefinition);
  const delivered: { eventId: string; name: string; cursor: string }[] = [];
  const native = {
    authority: (b: DotBinding) => enabled && b.worldId === "world" && b.sceneId === "scene" && b.userId === "gm" && b.clientId === "client",
    state: (b: DotBinding, combatId: string) => combatId === "combat" ? { state: { worldId: b.worldId, sessionId: b.sessionId, controllerId: b.controllerId, sceneId: b.sceneId, combatId, combatModifiedTime: version, round: 1, turn: 1, combatantIds: ["player", "monster"], paused: false }, playerCombatantIds: ["player"] } : undefined,
    findMessage: (id: string) => messages.get(id),
    createMessage: async (data: Record<string, unknown>) => { writes++; messages.set(data._id as string, data); mutationStarted?.(); await mutationGate; if (loseWriteReceipt) throw new Error("synthetic lost receipt"); return data; },
  };
  const browser = new browserModule.DotBridge("client", "gm", disk, native, (_event: string, payload: unknown) => {
    void runtime.ingress(payload, { clientId: "client", userId: "gm", lane: "gm" });
  });
  browser.setConnected(true);
  const setup: DotIntegrationSetup = { enabled: true, owner: "account", controller: { worldId: "world", sceneId: "scene", clientId: "client", userId: "gm" },
    active: () => enabled, verifyController: () => attest, authenticate: async req => req.header("authorization") === "synthetic-account" ? "account" : null,
    storagePath: "unused-synthetic-store", assertPrivateStorage: () => { throw new Error("Synthetic tests inject MemoryDotStore."); },
    codec: { seal: secret => Buffer.from(secret).toString("hex"), unseal: encoded => Buffer.from(encoded, "hex").toString() },
  };
  const bridge = {
    client: () => connected ? { clientId: "client", userId: "gm", lane: "gm", isGM: true, capabilities: ["dotBind", "dotRead", "dotRespond", "dotUnbind", "dotStatus"] } : null,
    call: async (command: string, payload: unknown, signal?: AbortSignal) => {
      if (command === "dotBind") return browser.bind(payload);
      if (command === "dotRead") return browser.read((payload as { combatId: string }).combatId);
      if (command === "dotStatus") return browser.getScope() ?? null;
      if (command === "dotRespond") {
        const cancellationId = (payload as { cancellationId: string }).cancellationId;
        const cancel = () => browser.receive({ kind: "dot-cancel-response", clientId: "client", cancellationId });
        signal?.addEventListener("abort", cancel, { once: true });
        try { responseQueued?.(); await responseGate; return await browser.respond(payload); }
        finally { signal?.removeEventListener("abort", cancel); }
      }
      if (command === "dotUnbind") { browser.unbind(); return { bound: false }; }
      throw new Error("Unexpected bridge command");
    },
    receipt: (clientId: string, eventId: string, accepted: boolean) => { browser.receive({ kind: "dot-receipt", clientId, eventId, accepted }); },
  };
  const webhooks = { verify: async () => undefined, send: async (input: { body: string }) => { webhookStarted?.(); await webhookGate; delivered.push(JSON.parse(input.body) as { eventId: string; name: string; cursor: string }); return { status: 204, body: "" }; } };
  let runtime = new DotIntegration(setup, bridge, store, webhooks);
  assert.equal(await runtime.bind(), true);
  const input = (): CompletedPlayerTurnInput => {
    const state = native.state(runtime.binding, "combat")!.state;
    const { worldId, sessionId, controllerId, sceneId } = runtime.binding;
    const scoped = { worldId, sessionId, controllerId, sceneId, combatId: "combat", stateRevision: dotStateRevision(state), previous: { round: 1, turn: 0, combatantId: "player" }, next: { round: 1, turn: 1, combatantId: "monster" } };
    return { ...scoped, eventId: completedTurnEventId(scoped), timestamp: new Date().toISOString() };
  };
  return { runtime, browser, input, store, disk, native, messages, delivered, setup, bridge, webhooks,
    restart: async (override?: Partial<DotIntegrationSetup>) => { await runtime.stop(); runtime = new DotIntegration({ ...setup, ...override }, bridge, store, webhooks); assert.equal(await runtime.bind(), true); return runtime; },
    holdResponse: () => { responseGate = new Promise(resolve => { releaseResponse = resolve; }); return new Promise<void>(resolve => { responseQueued = resolve; }); },
    holdMutation: () => { mutationGate = new Promise(resolve => { releaseMutation = resolve; }); return new Promise<void>(resolve => { mutationStarted = resolve; }); },
    releaseMutation: () => releaseMutation?.(),
    holdWebhook: () => { webhookGate = new Promise(resolve => { releaseWebhook = resolve; }); return new Promise<void>(resolve => { webhookStarted = resolve; }); },
    releaseWebhook: () => releaseWebhook?.(),
    releaseResponse: () => releaseResponse?.(), writes: () => writes, setVersion: (v: number) => { version = v; }, loseWriteReceipt: () => { loseWriteReceipt = true; }, revoke: () => { attest = false; }, disconnect: () => { connected = false; browser.setConnected(false); runtime.disconnected(); } };
}
function createApp(options?: McpEventsHttpOptions) {
  const app = express(); if (options) mountMcpEvents(app, "/dot/mcp", options);
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    void next; response.status((error as { status?: unknown }).status === 413 ? 413 : 400).json({ error: "Invalid scoped MCP request." });
  });
  return app;
}
function resultOf<T>(response: { body: unknown }): T { return (response.body as { result: T }).result; }
const rpc = (method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": DOT_PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} } } });

void test("CLI/default app has no dot endpoint; injected route authenticates separately and bounds raw body", async () => {
  await request(createApp()).post("/dot/mcp").send(rpc("server/discover")).expect(404);
  const f = await fixture(), app = createApp(f.runtime.httpOptions());
  await request(app).post("/dot/mcp").send(rpc("server/discover")).expect(401);
  const response = await request(app).post("/dot/mcp").set("authorization", "synthetic-account").set("mcp-protocol-version", DOT_PROTOCOL_VERSION).set("mcp-method", "tools/list").send(rpc("tools/list")).expect(200);
  assert.deepEqual(resultOf<{ tools: { name: string }[] }>(response).tools.map(t => t.name), ["foundry_dot_get_scope", "foundry_dot_read_turn", "foundry_dot_respond"]);
  await request(app).post("/dot/mcp").set("authorization", "synthetic-account").send({ padding: "x".repeat(33000) }).expect(413);
});

void test("subscriber discovers scope and subscribes using only authenticated public endpoint results", async () => {
  const f = await fixture(), app = createApp(f.runtime.httpOptions());
  const call = (method: string, params: Record<string, unknown> = {}) => {
    const operation = request(app).post("/dot/mcp").set("authorization", "synthetic-account").set("mcp-protocol-version", DOT_PROTOCOL_VERSION).set("mcp-method", method);
    if (method === "tools/call") operation.set("mcp-name", params.name as string);
    return operation.send(rpc(method, params)).expect(200);
  };
  const catalog = resultOf<{ tools: { name: string }[] }>(await call("tools/list")).tools;
  const bootstrap = catalog.find(tool => tool.name === "foundry_dot_get_scope"); assert.ok(bootstrap);
  const scope = resultOf<{ structuredContent: Record<string, string> }>(await call("tools/call", { name: bootstrap.name, arguments: {} })).structuredContent;
  assert.deepEqual(Object.keys(scope).sort(), ["controllerId", "sessionId", "worldId"]);
  const event = resultOf<{ events: { name: string }[] }>(await call("events/list")).events[0]!;
  const subscription = await call("events/subscribe", { name: event.name, arguments: scope, delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` } });
  const subscribed = resultOf<{ id: string; cursor: string }>(subscription); assert.ok(subscribed.id); assert.ok(subscribed.cursor);
  await request(app).post("/dot/mcp").set("mcp-protocol-version", DOT_PROTOCOL_VERSION).set("mcp-method", "tools/call").set("mcp-name", bootstrap.name).send(rpc("tools/call", { name: bootstrap.name, arguments: {} })).expect(401);
  await assert.rejects(f.runtime.httpOptions().tools.call("other", bootstrap.name, {}, new AbortController().signal));
  await assert.rejects(f.runtime.httpOptions().tools.call("account", bootstrap.name, { worldId: "other" }, new AbortController().signal));
  f.disconnect(); await assert.rejects(f.runtime.httpOptions().tools.call("account", bootstrap.name, {}, new AbortController().signal));
});

void test("same-controller restart preserves queued delivery, cursor and uncertain-response reconciliation", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  const scope = await f.runtime.httpOptions().tools.call("account", "foundry_dot_get_scope", {}, signal);
  const subscription = await f.runtime.events.subscribe("account", { name: "foundry.player_turn_completed", arguments: scope, delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` } }, signal);
  const input = f.input(); await f.browser.submitCompletedTurn(input, signal); f.loseWriteReceipt();
  const args = { eventId: input.eventId, stateRevision: input.stateRevision, text: "Resume this response" };
  assert.equal((await f.runtime.httpOptions().tools.call("account", "foundry_dot_respond", args, signal)).outcome, "uncertain");
  const pending = f.store.read(); assert.equal(pending.deliveries[0]!.status, "queued");
  const restarted = await f.restart();
  assert.deepEqual(await restarted.httpOptions().tools.call("account", "foundry_dot_get_scope", {}, signal), scope);
  assert.deepEqual(f.store.read(), pending);
  f.setVersion(456);
  const current = await restarted.httpOptions().tools.call("account", "foundry_dot_read_turn", { eventId: input.eventId }, signal);
  assert.equal((current.state as Record<string, unknown>).combatModifiedTime, 456);
  const retry = await restarted.httpOptions().tools.call("account", "foundry_dot_respond", args, signal);
  assert.equal(retry.outcome, "confirmed"); assert.equal(retry.replayed, true); assert.equal(f.writes(), 1);
  assert.deepEqual(await restarted.events.dispatchDue(signal), { attempted: 1, received: 1, deadLettered: 0 });
  assert.equal(f.delivered[0]!.eventId, input.eventId);
  assert.equal(f.delivered[0]!.cursor.split(".")[1], subscription.cursor.split(".")[1]);
});

void test("mismatched retained scope fails activation without retiring work", async () => {
  const f = await fixture(); await f.browser.submitCompletedTurn(f.input(), new AbortController().signal);
  const before = f.store.read();
  assert.throws(() => new DotIntegration({ ...f.setup, owner: "other-owner" }, f.bridge, f.store, f.webhooks), /reviewed recovery/);
  assert.throws(() => new DotIntegration({ ...f.setup, controller: { ...f.setup.controller, clientId: "another-browser" } }, f.bridge, f.store, f.webhooks), /reviewed recovery/);
  const legacy = new MemoryEventStore(completedTurnDefinition, { ...before, generation: randomUUID() }), legacyBefore = legacy.read();
  assert.throws(() => new DotIntegration(f.setup, f.bridge, legacy, f.webhooks), /reviewed recovery/);
  assert.deepEqual(legacy.read(), legacyBefore); assert.deepEqual(f.store.read(), before);
});

void test("delivery scheduler admits one pass while a webhook stalls and stops scheduling on shutdown", async t => {
  const f = await fixture(), signal = new AbortController().signal;
  const scope = await f.runtime.httpOptions().tools.call("account", "foundry_dot_get_scope", {}, signal);
  await f.runtime.events.subscribe("account", { name: "foundry.player_turn_completed", arguments: scope, delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` } }, signal);
  await f.browser.submitCompletedTurn(f.input(), signal);
  const entered = f.holdWebhook(), dispatch = f.runtime.events.dispatchDue.bind(f.runtime.events);
  let passes = 0;
  f.runtime.events.dispatchDue = async (passSignal, limit) => { passes++; return dispatch(passSignal, limit); };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    f.runtime.start(); f.runtime.start(); t.mock.timers.tick(1000); await entered;
    t.mock.timers.tick(30000); assert.equal(passes, 1); assert.equal(f.delivered.length, 0);
    f.releaseWebhook(); await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(999); assert.equal(passes, 1);
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(passes, 2);
    await f.runtime.stop(); t.mock.timers.tick(30000); await new Promise(resolve => setImmediate(resolve)); assert.equal(passes, 2);
  } finally { f.releaseWebhook(); await f.runtime.stop(); t.mock.timers.reset(); }
});

void test("real browser outbox resolves only after durable server ingress and dedupes reconnect replay", async () => {
  const f = await fixture(), input = f.input();
  await f.browser.submitCompletedTurn(input, new AbortController().signal);
  assert.equal(f.store.read().events.length, 1);
  await f.runtime.ingress({ ...input, timestamp: new Date(Date.now() - 3600000).toISOString() }, { clientId: "client", userId: "gm", lane: "gm" });
  assert.equal(f.store.read().events.length, 1);
  const stored = JSON.parse(f.disk.getItem("foundry-local-api.dot.v1.gm.client")!) as { turns: unknown[] };
  assert.equal(stored.turns.length, 0);
});

void test("forged identities, stale state, non-player turns and missing exact-world attestation are refused", async () => {
  const f = await fixture(), original = f.input();
  await f.runtime.ingress(original, { clientId: "forged", userId: "gm", lane: "gm" });
  await f.runtime.ingress(original, { clientId: "client", userId: "gm", lane: "player" });
  f.setVersion(124);
  await f.runtime.ingress(original, { clientId: "client", userId: "gm", lane: "gm" });
  assert.equal(f.store.read().events.length, 0);
  const changed = { ...f.input(), previous: { round: 1, turn: 0, combatantId: "monster" } };
  changed.eventId = completedTurnEventId(changed);
  await f.runtime.ingress(changed, { clientId: "client", userId: "gm", lane: "gm" });
  f.revoke(); assert.equal(await f.runtime.bind(), false);
  assert.equal(f.store.read().events.length, 0);
  assert.deepEqual(await f.runtime.httpOptions().tools.list("account"), []);
});

void test("scoped tools read exact revision, reject broad arguments, publish once and reconcile a lost write", async () => {
  const f = await fixture(), input = f.input(), signal = new AbortController().signal;
  await f.browser.submitCompletedTurn(input, signal);
  const tools = f.runtime.httpOptions().tools;
  const current = await tools.call("account", "foundry_dot_read_turn", { eventId: input.eventId }, signal);
  assert.equal(current.stateRevision, input.stateRevision);
  await assert.rejects(tools.call("other", "foundry_dot_read_turn", { eventId: input.eventId }, signal));
  await assert.rejects(tools.call("account", "foundry_dot_read_turn", { eventId: input.eventId, combatId: "other" }, signal));
  f.loseWriteReceipt();
  const args = { eventId: input.eventId, stateRevision: input.stateRevision, text: "The monster prepares to act. <script>unsafe</script>" };
  const first = await tools.call("account", "foundry_dot_respond", args, signal);
  assert.equal(first.outcome, "uncertain"); assert.equal(f.writes(), 1);
  f.setVersion(125);
  const reconciled = await tools.call("account", "foundry_dot_respond", args, signal);
  assert.equal(reconciled.outcome, "confirmed"); assert.equal(reconciled.replayed, true); assert.equal(f.writes(), 1);
  assert.match([...f.messages.values()][0]!.content as string, /&lt;script&gt;/);
  await assert.rejects(tools.call("account", "foundry_dot_respond", { ...args, text: "changed" }, signal));
});

void test("new stale responses never mutate, and disconnect revokes tools", async () => {
  const f = await fixture(), input = f.input(), signal = new AbortController().signal;
  await f.browser.submitCompletedTurn(input, signal); f.setVersion(900);
  await assert.rejects(f.runtime.httpOptions().tools.call("account", "foundry_dot_respond", { eventId: input.eventId, stateRevision: input.stateRevision, text: "stale" }, signal));
  assert.equal(f.writes(), 0); f.disconnect();
  assert.equal(await f.runtime.httpOptions().scopeForPrincipal("account"), null);
});

void test("canceling a queued browser response prevents its later mutation", async () => {
  const f = await fixture(), input = f.input(), controller = new AbortController();
  await f.browser.submitCompletedTurn(input, controller.signal);
  const queued = f.holdResponse();
  const response = f.runtime.httpOptions().tools.call("account", "foundry_dot_respond", { eventId: input.eventId, stateRevision: input.stateRevision, text: "Canceled before execution" }, controller.signal);
  const rejected = assert.rejects(response);
  await queued; controller.abort(); f.releaseResponse(); await rejected;
  assert.equal(f.writes(), 0); assert.equal(f.messages.size, 0);
});

void test("cancellation after a native write starts preserves uncertain reconciliation", async () => {
  const f = await fixture(), input = f.input(), controller = new AbortController();
  await f.browser.submitCompletedTurn(input, controller.signal); f.loseWriteReceipt();
  const started = f.holdMutation(), args = { eventId: input.eventId, stateRevision: input.stateRevision, text: "Write already started" };
  const response = f.runtime.httpOptions().tools.call("account", "foundry_dot_respond", args, controller.signal);
  await started; controller.abort(); f.releaseMutation();
  assert.equal((await response).outcome, "uncertain"); assert.equal(f.writes(), 1);
  const retry = await f.runtime.httpOptions().tools.call("account", "foundry_dot_respond", args, new AbortController().signal);
  assert.equal(retry.outcome, "confirmed"); assert.equal(retry.replayed, true); assert.equal(f.writes(), 1);
});

void test("browser outbox persistence failure refuses scope and submission", async () => {
  const f = await fixture();
  const broken = new browserModule.DotBridge("client", "gm", { getItem: () => null, setItem: () => { throw new Error("disk failed"); } }, f.native, () => undefined);
  broken.setConnected(true);
  assert.throws(() => broken.bind(f.runtime.binding));
  await assert.rejects(broken.submitCompletedTurn(f.input(), new AbortController().signal));
});

void test("complete synthetic turn -> durable event -> webhook -> scoped state -> one response receipt", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  const { worldId, sessionId, controllerId } = f.runtime.binding;
  const subscription = await f.runtime.events.subscribe("account", {
    name: "foundry.player_turn_completed", arguments: { worldId, sessionId, controllerId },
    delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` },
  }, signal);
  const input = f.input(); await f.browser.submitCompletedTurn(input, signal);
  assert.equal(f.store.read().deliveries[0]!.status, "queued");
  assert.deepEqual(await f.runtime.events.dispatchDue(signal), { attempted: 1, received: 1, deadLettered: 0 });
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.eventId, input.eventId);
  assert.equal(f.delivered[0]!.name, "foundry.player_turn_completed"); assert.notEqual(f.delivered[0]!.cursor, subscription.cursor);
  const tools = f.runtime.httpOptions().tools;
  const read = await tools.call("account", "foundry_dot_read_turn", { eventId: f.delivered[0]!.eventId }, signal);
  const args = { eventId: input.eventId, stateRevision: read.stateRevision, text: "The next combatant surveys the battlefield." };
  const response = await tools.call("account", "foundry_dot_respond", args, signal);
  assert.equal(response.outcome, "confirmed"); assert.equal(f.writes(), 1);
  const retry = await tools.call("account", "foundry_dot_respond", args, signal);
  assert.equal(retry.outcome, "confirmed"); assert.equal(retry.replayed, true); assert.equal(f.writes(), 1);
});
