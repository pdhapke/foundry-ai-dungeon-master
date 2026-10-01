import assert from "node:assert/strict";
import { it } from "node:test";

void it("mounted ChatKit uses one owner-scoped thread for actions, aborts streams and removes listeners on reopen (mocked component)", async () => {
  class Component extends EventTarget {
    options: unknown;
    actions: unknown[] = [];
    thread: string | null = null;
    removed = false;
    setOptions(options: unknown) {
      this.options = options;
      queueMicrotask(() => this.dispatchEvent(new Event("chatkit.ready")));
    }
    setThreadId(id: string) {
      this.thread = id;
      this.dispatchEvent(new CustomEvent("chatkit.thread.change", { detail: { threadId: id } }));
      return Promise.resolve();
    }
    sendCustomAction(action: unknown) {
      this.actions.push(action);
      this.dispatchEvent(new Event("chatkit.response.start"));
      this.dispatchEvent(new Event("chatkit.response.end"));
      return Promise.resolve();
    }
    remove() {
      this.removed = true;
    }
  }
  const components: Component[] = [];
  const status = { textContent: "" };
  const mount = { append: () => undefined };
  let renderCount = 0;
  class Base {
    element = {
      querySelector: (query: string) => (query === ".ai-dm-chatkit-mount" ? mount : status),
    };
    render() {
      renderCount++;
      (this as unknown as { _onRender(): void })._onRender();
      return Promise.resolve(this);
    }
    async close() {}
  }
  const storage = new Map<string, string>();
  const fetches: Array<{ input: unknown; init?: RequestInit | undefined }> = [];
  Object.assign(globalThis, {
    foundry: {
      applications: {
        api: { ApplicationV2: Base, HandlebarsApplicationMixin: (base: unknown) => base },
      },
    },
    window: { addEventListener: () => undefined, setTimeout, clearTimeout },
    game: {
      user: { id: "gm-one", isGM: true },
      world: { id: "world-one" },
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
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: (input: unknown, init?: RequestInit) => {
      fetches.push({ input, init });
      return Promise.resolve(
        new Response(JSON.stringify({ threadId: "thread_one" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });
  const { aiDmController } = await import("./controller.js");
  aiDmController.transport.chatKitHeaders = () => ({
    "x-ai-dm-session": "memory-only",
    "x-ai-dm-client": "client-one",
    "x-ai-dm-browser-session": "browser-one",
    "x-ai-dm-version": "0.1.0",
  });
  const { AiDungeonMasterApplication } = await import("./application.js");
  const app = AiDungeonMasterApplication.open();
  await app.trigger({ prompt: "First", requestId: "first", context: { sceneId: "scene" } });
  await app.trigger({ prompt: "Duplicate", requestId: "first" });
  await app.trigger({ prompt: "Second", requestId: "second" });
  assert.equal(AiDungeonMasterApplication.open(), app);
  assert.equal(renderCount, 2, "triggers and repeated opens preserve the already mounted frame");
  assert.equal(fetches.length, 1);
  assert.equal(components.length, 1);
  assert.equal(components[0]?.actions.length, 2);
  assert.equal(components[0]?.thread, "thread_one");
  assert.equal(new Headers(fetches[0]?.init?.headers).get("x-ai-dm-session"), "memory-only");
  assert.equal(
    storage.get("foundry-ai-dungeon-master.chatkit.thread.world-one.gm-one"),
    "thread_one",
  );
  const history = await app.authenticatedFetch("http://127.0.0.1:3940/chatkit", {
    method: "POST",
    headers: { "chatkit-frame-instance-id": "frame-one", "content-type": "application/json" },
    body: '{"type":"threads.list"}',
  });
  await history.text();
  const forwarded = new Headers(fetches[1]?.init?.headers);
  assert.equal(forwarded.has("chatkit-frame-instance-id"), false);
  assert.equal(forwarded.get("x-ai-dm-session"), "memory-only");
  assert.equal(fetches[1]?.init?.body, '{"type":"threads.list"}');
  await app.close();
  assert.equal(components[0]?.removed, true);
  components[0]?.dispatchEvent(
    new CustomEvent("chatkit.thread.change", { detail: { threadId: "should-not-persist" } }),
  );
  assert.equal(
    storage.get("foundry-ai-dungeon-master.chatkit.thread.world-one.gm-one"),
    "thread_one",
  );
  const reopened = AiDungeonMasterApplication.open();
  await reopened.trigger({ prompt: "Third", requestId: "third" });
  assert.equal(fetches.length, 2);
  assert.equal(components.length, 2);
  assert.equal((components[1]?.options as { initialThread: string }).initialThread, "thread_one");
  class NativeElement extends EventTarget {
    children: NativeElement[] = [];
    textContent = "";
    type = "";
    disabled = false;
    append(...nodes: NativeElement[]) {
      this.children.push(...nodes);
    }
    replaceChildren() {
      this.children = [];
    }
  }
  const panel = new NativeElement();
  const previousQuery = reopened.element.querySelector.bind(reopened.element);
  Object.assign(reopened.element, {
    querySelector: (query: string) =>
      query === ".ai-dm-native-actions" ? panel : previousQuery(query),
  });
  const previousCreate = document.createElement.bind(document);
  Object.assign(document, {
    createElement: (tag: string) =>
      tag === "openai-chatkit" ? previousCreate(tag) : new NativeElement(),
  });
  const decisions: unknown[] = [];
  let noteState = "pending";
  let refreshed: () => void = () => {};
  const refreshComplete = new Promise<void>((resolve) => {
    refreshed = resolve;
  });
  Object.assign(globalThis, {
    fetch: (_input: unknown, init?: RequestInit) => {
      assert.equal(typeof init?.body, "string");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      assert.equal(body["threadId"], "thread_one");
      assert.equal(new Headers(init?.headers).get("x-ai-dm-session"), "memory-only");
      if (body["decision"]) {
        decisions.push(body);
        noteState = "completed";
      } else if (noteState === "completed") refreshed();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            result: [
              {
                actionId: "note-one",
                kind: "note",
                status: noteState,
                input: { title: "A session note", text: "<script>untrusted</script>" },
                receipt: null,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
  const beforeReviewRenderCount = renderCount;
  await reopened.reviewNativeActions();
  assert.equal(
    panel.children[0]?.children[1]?.textContent,
    "<script>untrusted</script>",
    "preview uses textContent",
  );
  const approve = panel.children[0]?.children[2];
  assert.equal(approve?.textContent, "Approve private session journal");
  approve?.dispatchEvent(new Event("click"));
  await refreshComplete;
  assert.deepEqual(decisions, [
    { threadId: "thread_one", actionId: "note-one", decision: "approve" },
  ]);
  assert.equal(renderCount, beforeReviewRenderCount, "review preserves mounted ChatKit");
  Object.assign(document, { createElement: previousCreate });
  Object.assign(globalThis, {
    fetch: (_input: unknown, init?: RequestInit) => {
      fetches.push({ input: "stream", init });
      return Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  });
  await reopened.authenticatedFetch("http://127.0.0.1:3940/chatkit", { method: "POST" });
  const streamSignal = fetches.at(-1)?.init?.signal;
  assert.equal(streamSignal?.aborted, false);
  await reopened.close();
  assert.equal(streamSignal?.aborted, true);
  game.settings.get = (_id: string, key: string) =>
    key === "serverUrl" ? "ws://127.0.0.1:3940/ws" : "";
  let signIns = 0;
  const originalSignIn = aiDmController.beginChatGptSignIn.bind(aiDmController);
  aiDmController.beginChatGptSignIn = () => {
    signIns += 1;
    return true;
  };
  const withoutDomain = AiDungeonMasterApplication.open();
  AiDungeonMasterApplication.DEFAULT_OPTIONS.actions.chatGptSignIn();
  assert.equal(signIns, 1, "authorization control works without a domain key or ready component");
  await withoutDomain.close();
  aiDmController.beginChatGptSignIn = originalSignIn;
});
