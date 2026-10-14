import assert from "node:assert/strict";
import test from "node:test";

void test("independent cancellation during ChatKit readiness prevents later dispatch", async () => {
  class Component extends EventTarget {
    actions: unknown[] = [];
    setOptions() {}
    async setThreadId() {}
    sendCustomAction(action: unknown) {
      this.actions.push(action);
      return Promise.resolve();
    }
    remove() {}
  }
  let component: Component | undefined;
  const status = { textContent: "" };
  const mount = { append: () => {} };
  class Base {
    element = {
      querySelector: (query: string) => (query === ".ai-dm-chatkit-mount" ? mount : status),
    };
    render() {
      (this as unknown as { _onRender: () => void })._onRender();
      return Promise.resolve(this);
    }
    async close() {}
  }
  Object.assign(globalThis, {
    foundry: {
      applications: {
        api: { ApplicationV2: Base, HandlebarsApplicationMixin: (base: unknown) => base },
      },
    },
    window: { addEventListener: () => {}, setTimeout, clearTimeout },
    game: {
      user: { id: "gm", isGM: true },
      world: { id: "w" },
      settings: {
        get: (_id: string, key: string) =>
          key === "serverUrl" ? "ws://127.0.0.1:3940/ws" : "domain-public",
      },
    },
    canvas: undefined,
    customElements: { get: () => Component },
    document: {
      createElement: () => {
        component = new Component();
        return component;
      },
    },
    localStorage: { getItem: () => "thread", setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.resolve(new Response(JSON.stringify({ threadId: "thread" }))),
  });
  const { aiDmController } = await import("./controller.js");
  aiDmController.transport.chatKitHeaders = () => ({ "x-ai-dm-session": "fixture" });
  const { AiDungeonMasterApplication } = await import("./application.js");
  const app = AiDungeonMasterApplication.open();
  try {
    const pending = app.trigger({ prompt: "Cancelled during readiness", requestId: "cancelled" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(component);
    app.cancel();
    component.dispatchEvent(new Event("chatkit.ready"));
    await pending.catch(() => {});
    assert.equal(component.actions.length, 0);
  } finally {
    await app.close();
  }
});
