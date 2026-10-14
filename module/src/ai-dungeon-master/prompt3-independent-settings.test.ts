import assert from "node:assert/strict";
import test from "node:test";

void test("independent registered settings guard stale panel requests and preserve disconnected recovery", async () => {
  const callbacks = new Map<string, () => void>();
  const settings = new Map<string, { default: unknown; onChange?: () => void }>();
  const status = { tagName: "P", textContent: "", hidden: false };
  const check = { tagName: "BUTTON", disabled: true };
  const mount = { append() {} };
  const drawer = { tagName: "DETAILS", hidden: true, open: false };
  let component: Component | undefined;
  class Component extends EventTarget { setOptions() { queueMicrotask(() => this.dispatchEvent(new Event("chatkit.ready"))); } remove() {} }
  class Base {
    element = { querySelector: (query: string) => query === ".ai-dm-chatkit-status" ? status : query === '[data-action="chatGptRefresh"]' ? check : query === ".ai-dm-chatkit-mount" ? mount : query === ".ai-dm-review-drawer" ? drawer : null };
    render() { (this as unknown as { _onRender(): void })._onRender(); return Promise.resolve(this); }
    close() { return Promise.resolve(); }
  }
  let requests = 0;
  Object.assign(globalThis, {
    Hooks: { once: (key: string, cb: () => void) => callbacks.set(key, cb), on() {} },
    foundry: { applications: { api: { ApplicationV2: Base, HandlebarsApplicationMixin: (base: unknown) => base } } },
    window: { addEventListener() {}, setTimeout, clearTimeout },
    game: { user: { id: "gm", isGM: true }, world: { id: "world" }, keybindings: { register() {} }, settings: { register: (_id: string, key: string, value: { default: unknown; onChange?: () => void }) => settings.set(key, value), get: (_id: string, key: string) => key === "serverUrl" ? "ws://127.0.0.1:3940/ws" : key === "latencyDiagnosticsEnabled" ? false : "public-domain" } },
    customElements: { get: () => Component }, document: { createElement: () => { component = new Component(); return component; } }, localStorage: { getItem: () => "stored-thread", setItem() {}, removeItem() {} },
    fetch: () => { requests++; return Promise.resolve(Response.json({})); },
  });
  await import("../index.js");
  callbacks.get("init")!();
  assert.equal(settings.get("latencyDiagnosticsEnabled")!.default, false);
  assert.equal(settings.get("dmEventMode")!.default, "embedded", "dot event production is inactive by default");
  const { AiDungeonMasterApplication } = await import("./application.js");
  const { aiDmController } = await import("./controller.js");
  let reviewReads = 0;
  let releaseReviews!: () => void;
  const reviewHold = new Promise<void>(resolve => { releaseReviews = resolve; });
  for (const key of ["reviewNativeActions", "reviewAttackActions", "reviewCampaignActions", "reviewWorldActions"] as const) {
    AiDungeonMasterApplication.prototype[key] = async () => { reviewReads++; await reviewHold; };
  }
  let reconnects = 0;
  aiDmController.reconnect = () => { reconnects++; };
  const app = AiDungeonMasterApplication.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reviewReads, 5, "stored conversation checks pending proposals on supported ready event");
  app.checkPendingReviews();
  assert.equal(reviewReads, 5, "same-thread contextual checks share one pending batch");
  releaseReviews();
  await new Promise<void>(resolve => setImmediate(resolve));
  component!.dispatchEvent(new CustomEvent("chatkit.thread.change", { detail: { threadId: "selected-thread" } }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reviewReads, 10, "thread selection independently checks restored proposals without inference");
  app.showReviewDrawer();
  assert.equal(drawer.hidden, false);
  app.invalidateReviews();
  assert.equal(drawer.hidden, true, "stale review rows do not occupy the new conversation layout");
  assert.equal(drawer.open, false);
  app.updateProviderControls();
  assert.equal(check.disabled, false);
  app.recoverConnection();
  assert.equal(reconnects, 1);
  assert.equal(requests, 0);
  settings.get("latencyDiagnosticsEnabled")!.onChange!();
  assert.doesNotMatch(status.textContent, /settings changed/i);
  settings.get("serverUrl")!.onChange!();
  assert.match(status.textContent, /Server settings changed/);
  app.checkPreparation(); app.recoverConnection();
  assert.match(status.textContent, /Server settings changed/);
  assert.equal(status.hidden, false);
  await assert.rejects(app.authenticatedFetch("http://127.0.0.1:3940/chatkit/actions", { method: "POST", body: "{}" }), /Server settings changed/);
  assert.equal(requests, 0);
  assert.equal(reconnects, 2, "server URL change reconnects authentication once; guarded recovery does not repeat it");
  await app.close();
  const reopened = AiDungeonMasterApplication.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  settings.get("chatKitDomainKey")!.onChange!();
  assert.match(status.textContent, /ChatKit settings changed/);
  await assert.rejects(reopened.authenticatedFetch("http://127.0.0.1:3940/chatkit/actions"), /ChatKit settings changed/);
  assert.equal(requests, 0);
  await reopened.close();
});
