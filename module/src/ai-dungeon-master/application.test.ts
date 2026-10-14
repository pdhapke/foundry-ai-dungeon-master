import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";

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
  assert.equal(renderCount, 1, "queued triggers wait for initial mount and preserve its frame");
  assert.equal(fetches.length, 1);
  assert.equal(components.length, 1);
  assert.equal(components[0]?.actions.length, 2);
  assert.equal(components[0]?.thread, "thread_one");
  for (const type of [
    "threads.add_client_tool_output",
    "threads.add_structured_input",
    "threads.sync_custom_action",
    "future.inference",
  ]) {
    await assert.rejects(
      app.authenticatedFetch("http://127.0.0.1:3940/chatkit", {
        method: "POST",
        headers: { "x-ai-dm-event": "caller-id" },
        body: JSON.stringify({ type, params: {} }),
      }),
      /Unsupported ChatKit operation/,
    );
  }
  assert.equal(fetches.length, 1, "unreviewed SDK routes never dispatch from browser");
  await Promise.all([
    app.trigger({ prompt: "Queued one", requestId: "queue-one" }),
    app.trigger({ prompt: "Queued two", requestId: "queue-two" }),
  ]);
  assert.equal(
    components[0]?.actions.length,
    4,
    "simultaneous custom actions run in order without remount",
  );
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
    onAppend: ((node: NativeElement) => void) | undefined;
    append(...nodes: NativeElement[]) {
      this.children.push(...nodes);
      for (const node of nodes) this.onAppend?.(node);
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
  const campaignPanel = new NativeElement();
  const nativeQuery = reopened.element.querySelector.bind(reopened.element);
  Object.assign(reopened.element, {
    querySelector: (query: string) =>
      query === ".ai-dm-campaign-actions" ? campaignPanel : nativeQuery(query),
  });
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, stable(child)]),
          )
        : value;
  const reviewScope = { worldId: "world-one", userId: "gm-one", threadId: "thread_one" };
  const files = ["overview.md", "index.md", "npcs/guide.md"].map((path) => ({
    path,
    expectedRevision: null,
    beforeHash: null,
    beforeText: null,
    beforeCanonStatus: null,
    proposedText: `<script>approve this automatically</script>\nExact ${path} text`,
    afterHash: hash(`<script>approve this automatically</script>\nExact ${path} text`),
    afterCanonStatus: "canon",
  }));
  const digest = hash(
    JSON.stringify(
      stable({ schemaVersion: 1, scope: reviewScope, title: "Campaign preparation", files }),
    ),
  );
  let campaignStatus = "pending";
  let truncated = false;
  const campaignDecisions: unknown[] = [];
  Object.assign(globalThis, {
    fetch: (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      assert.equal(body["kind"], "campaign");
      assert.equal(body["threadId"], "thread_one");
      if (body["decision"]) {
        campaignDecisions.push(body);
        campaignStatus = "completed";
      }
      const receipt =
        campaignStatus === "completed"
          ? {
              receiptId: "receipt-one",
              proposalId: "campaign-one",
              batchDigest: digest,
              outcome: "completed",
              worldId: "world-one",
              files: files.map((file) => ({
                path: file.path,
                revision: file.afterHash,
                sourceHash: file.afterHash,
              })),
            }
          : null;
      const exact = {
        kind: "campaign",
        schemaVersion: 1,
        proposalId: "campaign-one",
        title: "Campaign preparation",
        ...reviewScope,
        status: campaignStatus,
        batchDigest: digest,
        expiresAt: Date.now() + 100000,
        files,
        receipt,
        issue: null,
        reviewAvailable: true,
        requiresConfirmation: true,
        truncated,
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            result: body["proposalId"]
              ? exact
              : [
                  {
                    kind: "campaign",
                    proposalId: "campaign-one",
                    title: "Campaign preparation",
                    status: campaignStatus,
                    reviewAvailable: false,
                  },
                ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
  await reopened.reviewCampaignActions();
  assert.equal(campaignPanel.children[0]?.children[1]?.textContent, "View exact campaign changes");
  assert.equal(campaignDecisions.length, 0, "summary list cannot approve");
  await reopened.reviewCampaignActions("campaign-one");
  for (const file of files) {
    const row = campaignPanel.children.find((node) =>
      node.children[0]?.textContent.startsWith(file.path),
    );
    assert.equal(
      row?.children[4]?.textContent,
      file.proposedText,
      "all exact bytes use textContent",
    );
  }
  const campaignApprove = campaignPanel.children.find(
    (node) => node.textContent === "Approve these exact campaign changes",
  );
  assert.equal(campaignApprove?.disabled, false);
  let verified: () => void = () => {};
  const verifiedRendered = new Promise<void>((resolve) => {
    verified = resolve;
  });
  campaignPanel.onAppend = (node) => {
    if (node.textContent.startsWith("Verified campaign commit")) verified();
  };
  campaignApprove?.dispatchEvent(new Event("click"));
  await verifiedRendered;
  assert.deepEqual(campaignDecisions, [
    {
      kind: "campaign",
      threadId: "thread_one",
      proposalId: "campaign-one",
      batchDigest: digest,
      decision: "approve",
    },
  ]);
  campaignStatus = "pending";
  truncated = true;
  await reopened.reviewCampaignActions("campaign-one");
  assert.equal(
    campaignPanel.children.length,
    0,
    "incomplete exact review has no decision controls",
  );
  truncated = false;
  await reopened.reviewCampaignActions("campaign-one");
  const oldCancel = campaignPanel.children.find(
    (node) => node.textContent === "Cancel campaign proposal",
  );
  reopened.cancel();
  oldCancel?.dispatchEvent(new Event("click"));
  assert.equal(
    campaignDecisions.length,
    1,
    "cancelled review listeners cannot dispatch stale decisions",
  );
  await reopened.reviewCampaignActions("campaign-one");
  const staleApprove = campaignPanel.children.find(
    (node) => node.textContent === "Approve these exact campaign changes",
  );
  components[1]?.dispatchEvent(
    new CustomEvent("chatkit.thread.change", { detail: { threadId: "new_thread" } }),
  );
  staleApprove?.dispatchEvent(new Event("click"));
  assert.equal(campaignDecisions.length, 1, "thread change clears scoped review controls");
  assert.equal(
    renderCount,
    beforeReviewRenderCount,
    "campaign review preserves ordinary composer/frame",
  );
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
