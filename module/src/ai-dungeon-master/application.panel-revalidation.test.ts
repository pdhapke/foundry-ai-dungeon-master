import assert from "node:assert/strict";
import test from "node:test";

void test("independent stale component thread event cannot write another world's pointer", async () => {
  class Component extends EventTarget {
    setOptions() {
      queueMicrotask(() => this.dispatchEvent(new Event("chatkit.ready")));
    }
    setThreadId() {
      return Promise.resolve();
    }
    sendCustomAction() {
      return Promise.resolve();
    }
    remove() {}
  }
  let component: Component | undefined;
  const pointers = new Map<string, string>();
  const mount = { append: () => {} };
  const status = { textContent: "" };
  class Base {
    element = {
      querySelector: (query: string) => (query === ".ai-dm-chatkit-mount" ? mount : status),
    };
    render() {
      (this as unknown as { _onRender(): void })._onRender();
      return Promise.resolve(this);
    }
    close() {
      return Promise.resolve();
    }
  }
  const state = {
    user: { id: "gm", isGM: true },
    world: { id: "original" },
    settings: {
      get: (_id: string, key: string) =>
        key === "serverUrl" ? "ws://127.0.0.1:3940/ws" : "domain-public",
    },
  };
  Object.assign(globalThis, {
    foundry: {
      applications: {
        api: { ApplicationV2: Base, HandlebarsApplicationMixin: (base: unknown) => base },
      },
    },
    window: { addEventListener: () => {}, setTimeout, clearTimeout },
    game: state,
    canvas: undefined,
    customElements: { get: () => Component },
    document: {
      createElement: () => {
        component = new Component();
        return component;
      },
    },
    localStorage: {
      getItem: (key: string) => pointers.get(key) ?? null,
      setItem: (key: string, value: string) => pointers.set(key, value),
      removeItem: (key: string) => pointers.delete(key),
    },
  });
  const { AiDungeonMasterApplication } = await import("./application.js");
  const app = AiDungeonMasterApplication.open();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(component);
    app.cancel();
    state.world.id = "different";
    state.user.id = "other-user";
    component.dispatchEvent(
      new CustomEvent("chatkit.thread.change", { detail: { threadId: "old-owner-thread" } }),
    );
    assert.equal(
      pointers.get("foundry-ai-dungeon-master.chatkit.thread.different.other-user"),
      undefined,
    );
  } finally {
    await app.close();
  }
});
