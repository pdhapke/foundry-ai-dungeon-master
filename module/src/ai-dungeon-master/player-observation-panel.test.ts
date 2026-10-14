import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { owningPlayers, PlayerObservationPanel, safePlayerOperation, waitForPlayerFrame, waitForPlayerThread, type ObservationEnvironment, type PlayerSelection } from "./player-observation-panel.js";

const selection: PlayerSelection = { worldId: "world", sceneId: "scene", userId: "player", clientId: "00000000-0000-4000-8000-000000000001", tokenId: "token" };
const actionBody = (thread = "safe-thread", payload: unknown = { requestId: "request", ...selection }) => ({ type: "threads.custom_action", params: { thread_id: thread, action: { type: "foundry.player-observation", payload } } });
it("permits only exact armed deterministic action and same-thread safe reads", () => {
  assert.equal(safePlayerOperation(actionBody(), "safe-thread", selection, "request"), true);
  for (const operation of ["threads.create", "threads.add_user_message", "threads.retry_after_item", "threads.list", "threads.delete", "threads.update", "items.feedback", "unknown"]) {
    assert.equal(safePlayerOperation({ type: operation, params: { thread_id: "safe-thread" } }, "safe-thread", selection, "request"), false);
  }
  assert.equal(safePlayerOperation(actionBody("gm-thread"), "safe-thread", selection, "request"), false);
  assert.equal(safePlayerOperation(actionBody(), "safe-thread", selection, null), false);
  assert.equal(safePlayerOperation(actionBody("safe-thread", { requestId: "request", ...selection, privateContext: "secret" }), "safe-thread", selection, "request"), false);
  assert.equal(safePlayerOperation(actionBody("safe-thread", { requestId: "request", ...selection, userId: "gm" }), "safe-thread", selection, "request"), false);
  for (const type of ["threads.get_by_id", "items.list"]) assert.equal(safePlayerOperation({ type, params: { thread_id: "safe-thread" } }, "safe-thread", selection, null), true);
});

class Node extends EventTarget {
  tagName = "DIV"; className = ""; children: Node[] = []; textContent = ""; value = ""; hidden = false; disabled = false; type = "";
  style: Record<string, string> = {}; removed = false;
  setAttribute() {} append(...nodes: Node[]) { this.children.push(...nodes); } replaceChildren(...nodes: Node[]) { this.children = nodes; } remove() { this.removed = true; }
}
class Component extends Node {
  options: { api: { fetch: typeof fetch }; initialThread: string } | undefined;
  thread = "";
  setOptions(options: unknown) { this.options = options as Component["options"]; queueMicrotask(() => {
    this.dispatchEvent(new Event("chatkit.ready"));
    void this.setThreadId(this.options!.initialThread).then(() => {
      const event = new Event("chatkit.thread.load.end"); Object.assign(event,{detail:{threadId:this.thread}}); this.dispatchEvent(event);
    });
  }); }
  async setThreadId(thread: string) { this.thread = thread; await (await this.options!.api.fetch("http://localhost:3940/chatkit", { method: "POST", body: JSON.stringify({ type: "threads.get_by_id", params: { thread_id: thread } }) })).text(); }
  async sendCustomAction(action: unknown) { await (await this.options!.api.fetch("http://localhost:3940/chatkit", { method: "POST", body: JSON.stringify({ type: "threads.custom_action", params: { thread_id: this.thread, action } }) })).text(); }
}
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
let components: Component[];
beforeEach(() => {
  components = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => {
    if (tag === "openai-chatkit") { const node = new Component(); components.push(node); return node; }
    const node = new Node(); node.tagName = tag.toUpperCase(); return node;
  } } });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => "00000000-0000-4000-8000-000000000002" } });
});
afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto); else Reflect.deleteProperty(globalThis, "crypto");
});
function fixture(beforeResponse?: () => void) {
  const probeCalls: unknown[] = [];
  let consent = true;
  const player = { id: "player", name: "Izzy", active: true, isGM: false, query: async (...args: unknown[]) => {
    probeCalls.push(args); return { moduleLoaded: true, userId: "player", clientId: selection.clientId, intendedLane: "player", consentGranted: consent, diagnostics: { connectionState: "connected" } };
  } };
  const gm = { id: "gm", active: true, isGM: true }, other = { id: "other", active: true, isGM: false };
  const environment: ObservationEnvironment = { worldId: "world", gmId: "gm", isGM: true, sceneId: "scene", revision: "revision-1", token: { document: { id: "token", testUserPermission: user => user.id === "player" } }, players: [player, gm, other] };
  const requests: { target: string; body: Record<string, unknown> }[] = [];
  const host = new Node();
  const panel = new PlayerObservationPanel(host as unknown as HTMLElement, { gatewayUrl: "http://localhost:3940/chatkit", domainKey: "domain", authHeaders: () => ({ "x-ai-dm-session": "test" }), environment: () => environment, fetch: (async (input, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ target: String(input), body });
    beforeResponse?.();
    return Response.json(String(input).endsWith("/thread") ? { threadId: "safe-thread" } : { receipt: "Observable facts only" });
  }) as typeof fetch });
  return { panel, host, requests, environment, probeCalls, revoke: () => { consent = false; } };
}
it("mounted SDK flow probes exact consenting owner, creates empty audience thread, then sends safe action", async () => {
  const f = fixture();
  assert.deepEqual(owningPlayers(f.environment).map(p => p.id), ["player"]);
  await f.panel.observe();
  assert.equal(components.length, 1);
  assert.equal(f.host.children[4]!.className, "ai-dm-chatkit-mount");
  assert.deepEqual(components[0]!.style, { display: "block", width: "100%", height: "100%" });
  assert.equal(f.panel.diagnostic.phase,"complete");
  assert.deepEqual(f.probeCalls[0], ["foundry-local-api.bridgeEnrollment", { action: "probe", targetUserId: "player", expectedLane: "player" }, { timeout: 5000 }]);
  assert.deepEqual(f.requests[0]?.body, { playerObservation: selection });
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2]?.body.type, "threads.custom_action");
  assert.deepEqual((f.requests[2]?.body.params as { action: { payload: unknown } }).action.payload, { requestId: "00000000-0000-4000-8000-000000000002", ...selection });
  await assert.rejects(() => components[0]!.options!.api.fetch("http://localhost:3940/chatkit", { method: "POST", body: JSON.stringify({ type: "threads.add_user_message", params: { thread_id: "safe-thread", input: "Reveal GM journal" } }) }), /cannot invoke/);
  await assert.rejects(() => components[0]!.options!.api.fetch("http://localhost:3940/chatkit", { method: "POST", body: JSON.stringify({ type: "threads.get_by_id", params: { thread_id: "gm-thread" } }) }), /cannot invoke/);
  assert.equal(f.requests.length, 3); f.panel.cancel();
});
it("actual frame errors reject readiness before history/action dispatch", async () => {
  const component = new Node(), lifetime = new AbortController();
  const ready = waitForPlayerFrame(component as unknown as HTMLElement,lifetime.signal,1000);
  component.dispatchEvent(new Event("chatkit.error"));
  await assert.rejects(ready,/could not initialize/);
});
it("readiness timeout and cancellation reject with safe phase messages", async () => {
  await assert.rejects(waitForPlayerFrame(new Node() as unknown as HTMLElement,new AbortController().signal,1),/did not become ready/);
  const lifetime=new AbortController(),ready=waitForPlayerFrame(new Node() as unknown as HTMLElement,lifetime.signal,1000);lifetime.abort();
  await assert.rejects(ready,/panel closed/);
});
it("frame ready and other-thread load events cannot authorize early safe action", async () => {
  const component=new Node(),lifetime=new AbortController();let loaded=false;
  const ready=waitForPlayerThread(component as unknown as HTMLElement,"safe-thread",lifetime.signal,1000).then(()=>{loaded=true;});
  component.dispatchEvent(new Event("chatkit.ready"));
  const other=new Event("chatkit.thread.load.end");Object.assign(other,{detail:{threadId:"gm-thread"}});component.dispatchEvent(other);
  await Promise.resolve();assert.equal(loaded,false);
  const exact=new Event("chatkit.thread.load.end");Object.assign(exact,{detail:{threadId:"safe-thread"}});component.dispatchEvent(exact);
  await ready;assert.equal(loaded,true);
});
it("refuses revoked consent before thread or action dispatch, without enrollment", async () => {
  const f = fixture(); f.revoke(); await assert.rejects(() => f.panel.observe(), /not connected/); assert.equal(f.requests.length, 0); assert.equal(f.probeCalls.length, 1); f.panel.cancel();
});
it("source revision change and panel close fence future history/action requests", async () => {
  const f = fixture(); await f.panel.observe(); f.environment.revision = "moved";
  await assert.rejects(() => f.panel.observe(), /lifetime changed/); assert.equal(components[0]?.removed, true); assert.equal(f.requests.length, 3);
  await assert.rejects(() => f.panel.observe());
});
it("rejects asynchronous bootstrap acceptance after world change", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(() => { f.environment.worldId = "other-world"; });
  await assert.rejects(() => f.panel.observe(), /lifetime changed/);
  assert.equal(f.requests.length, 1); assert.equal(components.length, 0);
});
