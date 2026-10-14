import assert from "node:assert/strict";
import test from "node:test";
void test("readiness cannot hide actionable mount error and Stop is contextual (mock DOM)", async () => {
  class Component extends EventTarget { setOptions() { queueMicrotask(() => this.dispatchEvent(new Event("chatkit.ready"))); } remove() {} }
  const status = { tagName: "P", textContent: "", hidden: false };
  const stop = { tagName: "BUTTON", hidden: true, disabled: false };
  const mount = { append() {} };
  class Base {
    element = { querySelector: (query: string) => query === ".ai-dm-chatkit-mount" ? mount : query === ".ai-dm-chatkit-status" ? status : query === '[data-action="cancelResponse"]' ? stop : null };
    render() { (this as unknown as { _onRender(): void })._onRender(); return Promise.resolve(this); }
    close() { return Promise.resolve(); }
  }
  let component: Component | undefined;
  let domain = "";
  let prepared: (value: Response) => void = () => {};
  const preparation = new Promise<Response>(resolve => { prepared = resolve; });
  Object.assign(globalThis, {
    foundry: { applications: { api: { ApplicationV2: Base, HandlebarsApplicationMixin: (base: unknown) => base } } },
    window: { addEventListener() {}, setTimeout, clearTimeout }, game: { user: { id: "gm", isGM: true }, world: { id: "world" }, settings: { get: (_id: string, key: string) => key === "serverUrl" ? "ws://127.0.0.1:3940/ws" : domain } },
    customElements: { get: () => Component }, document: { createElement: () => { component = new Component(); return component; } }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => preparation,
  });
  const { aiDmController } = await import("./controller.js");
  aiDmController.transport.chatKitHeaders = () => ({ "x-ai-dm-session": "fixture" });
  aiDmController.store.setAuthenticated("gm", "connected");
  Object.assign(aiDmController.store.state.chatGpt, { state: "ready", identityConnected: true, planUsageAuthorized: true, modelDiscoveryState: "available", selectedModel: "fixture", availableModels: [{ slug: "fixture", displayName: "Fixture" }] });
  const { AiDungeonMasterApplication } = await import("./application.js");
  const app = AiDungeonMasterApplication.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(status.textContent, /domain key/);
  prepared(new Response(JSON.stringify({ state: "ready", validUntil: new Date(Date.now() + 60000).toISOString() })));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(status.textContent, /domain key/);
  assert.equal(status.hidden, false);
  assert.equal(stop.hidden, true, "preparation and review reads are not cancellable response controls");
  app.cancel();
  assert.match(status.textContent, /Confirmed changes remain/);
  assert.equal(stop.hidden, true);
  await app.close();
  domain = "domain-public";
  const reopened = AiDungeonMasterApplication.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(component);
  component.dispatchEvent(new Event("chatkit.response.start"));
  assert.equal(stop.hidden, false, "Stop appears during response");
  component.dispatchEvent(new Event("chatkit.response.end"));
  assert.equal(stop.hidden, true, "Stop disappears at response end");
  await reopened.close();
});

