import assert from "node:assert/strict";
import test from "node:test";

void test("cancel/close at thread HTTP, body, and component awaits prevents later dispatch or stale persistence (mocked component)", async () => {
  let setThreadHold: Promise<void> | undefined;
  let setThreadStarted: () => void = () => {};
  class Component extends EventTarget {
    actions: unknown[] = [];
    setOptions() {
      queueMicrotask(() => this.dispatchEvent(new Event("chatkit.ready")));
    }
    async setThreadId(id: string) {
      setThreadStarted();
      await setThreadHold;
      this.dispatchEvent(new CustomEvent("chatkit.thread.change", { detail: { threadId: id } }));
    }
    sendCustomAction(action: unknown) {
      this.actions.push(action);
      return Promise.resolve();
    }
    remove() {}
  }
  const components: Component[] = [];
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
  const pointers = new Map<string, string>();
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
        const component = new Component();
        components.push(component);
        return component;
      },
    },
    localStorage: {
      getItem: (key: string) => pointers.get(key) ?? null,
      setItem: (key: string, value: string) => pointers.set(key, value),
      removeItem: (key: string) => pointers.delete(key),
    },
  });
  const { aiDmController } = await import("./controller.js");
  aiDmController.transport.chatKitHeaders = () => ({ "x-ai-dm-session": "fixture" });
  const { AiDungeonMasterApplication } = await import("./application.js");
  let fetched: () => void = () => {};
  let resolveResponse: (response: Response) => void = () => {};
  const fetching = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  Object.assign(globalThis, {
    fetch: () => {
      fetched();
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    },
  });
  let app = AiDungeonMasterApplication.open();
  const pending = app.trigger({ prompt: "Cancel before HTTP completes", requestId: "http" });
  await fetching;
  app.cancel();
  await assert.rejects(pending, /cancelled/);
  resolveResponse(new Response(JSON.stringify({ threadId: "late_http" })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pointers.size, 0);
  assert.equal(components[0]!.actions.length, 0);
  await app.close();

  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bodyStarted: () => void = () => {};
  const parsing = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  Object.assign(globalThis, {
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
              bodyStarted();
            },
          }),
        ),
      ),
  });
  app = AiDungeonMasterApplication.open();
  const parsingTurn = app.trigger({ prompt: "Close during JSON body", requestId: "body" });
  await parsing;
  await app.close();
  await assert.rejects(parsingTurn, /cancelled/);
  body!.enqueue(new TextEncoder().encode(JSON.stringify({ threadId: "late_body" })));
  body!.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pointers.size, 0);
  assert.equal(components[1]!.actions.length, 0);

  let releaseSet: () => void = () => {};
  setThreadHold = new Promise<void>((resolve) => {
    releaseSet = resolve;
  });
  const setting = new Promise<void>((resolve) => {
    setThreadStarted = resolve;
  });
  Object.assign(globalThis, {
    fetch: () => Promise.resolve(new Response(JSON.stringify({ threadId: "authorized_thread" }))),
  });
  app = AiDungeonMasterApplication.open();
  const settingTurn = app.trigger({
    prompt: "Cancel during component thread selection",
    requestId: "selection",
  });
  await setting;
  app.cancel();
  await assert.rejects(settingTurn, /cancelled/);
  components[2]!.dispatchEvent(
    new CustomEvent("chatkit.thread.change", { detail: { threadId: "new_user_thread" } }),
  );
  releaseSet();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(components[2]!.actions.length, 0);
  assert.equal(
    pointers.get("foundry-ai-dungeon-master.chatkit.thread.w.gm"),
    "new_user_thread",
    "late cancelled programmatic thread event cannot overwrite a newer user conversation",
  );
  await app.close();
  setThreadHold = undefined;
  app = AiDungeonMasterApplication.open();
  await app.trigger({ prompt: "New panel can play normally", requestId: "reopened" });
  assert.equal(components[3]!.actions.length, 1);
  assert.equal(components[2]!.actions.length, 0);
  await app.close();
});
