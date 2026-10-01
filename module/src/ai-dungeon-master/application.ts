import type { OpenAIChatKit } from "@openai/chatkit";
import { aiDmController } from "./controller.js";
import { chatGptPanelStatus } from "./chatgpt-panel.js";
import { chatKitDomainKey } from "./chatkit-domain.js";
import {
  boundedContext,
  currentGameContext,
  TriggerGuard,
  type ChatKitTrigger,
} from "./chatkit-context.js";
const MODULE_ID = "foundry-ai-dungeon-master";
const RUNTIME_URL = "https://cdn.platform.openai.com/deployments/chatkit/chatkit.js";
let runtimePromise: Promise<void> | undefined;
function loadRuntime(): Promise<void> {
  if (customElements.get("openai-chatkit")) return Promise.resolve();
  if (!runtimePromise)
    runtimePromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = RUNTIME_URL;
      script.async = true;
      script.addEventListener(
        "load",
        () => {
          void customElements.whenDefined("openai-chatkit").then(() => resolve());
        },
        { once: true },
      );
      script.addEventListener(
        "error",
        () => {
          runtimePromise = undefined;
          script.remove();
          reject(new Error("ChatKit could not load. Check network access to the OpenAI CDN."));
        },
        { once: true },
      );
      document.head.append(script);
    });
  return runtimePromise;
}
function gatewayUrl(): string {
  const url = new URL(String(game.settings.get(MODULE_ID, "serverUrl")));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${url.origin}/chatkit`;
}
function pointerKey(): string {
  return `${MODULE_ID}.chatkit.thread.${game.world?.id ?? "none"}.${game.user.id}`;
}
const Base = foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2,
);
export class AiDungeonMasterApplication extends Base {
  static DEFAULT_OPTIONS = {
    id: MODULE_ID,
    classes: [MODULE_ID],
    tag: "div",
    position: { width: 620, height: 720 },
    window: { title: "AI Dungeon Master", resizable: true, minimizable: true },
    actions: {
      contextResponse: () => {
        void this.#instance
          ?.trigger({
            prompt: "Describe the current game situation using the supplied context.",
            context: currentGameContext(),
          })
          .catch((error) => this.#instance?.fail(error));
      },
      cancelResponse: () => this.#instance?.cancel(),
      reviewNativeActions: () => {
        void this.#instance?.reviewNativeActions().catch((error) => this.#instance?.fail(error));
      },
      chatGptSignIn: () =>
        this.#instance?.providerAction(() => aiDmController.beginChatGptSignIn()),
      chatGptRefresh: () =>
        this.#instance?.providerAction(() => aiDmController.refreshChatGptStatus()),
      chatGptSignOut: () => this.#instance?.providerAction(() => aiDmController.signOutChatGpt()),
    },
  };
  static PARTS = {
    main: { template: `modules/${MODULE_ID}/module/templates/ai-dungeon-master/application.hbs` },
  };
  static #instance: AiDungeonMasterApplication | null = null;
  #component: OpenAIChatKit | null = null;
  #mounting: Promise<void> | null = null;
  #ready: Promise<void> | null = null;
  #listeners: AbortController | null = null;
  #requests = new Set<AbortController>();
  #guard = new TriggerGuard();
  #closed = false;
  #threadId: string | null = null;
  #status = "Connecting to ChatKit…";
  #requestFailed = false;
  #unsubscribe: (() => void) | null = null;
  #providerListeners: AbortController | null = null;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    this.#unsubscribe = aiDmController.store.subscribe(() => {
      if (!this.#closed) this.updateProviderControls();
    });
  }
  static open(): AiDungeonMasterApplication {
    const instance = this.#instance ?? new this();
    this.#instance = instance;
    if (!instance.#component) instance.render({ force: true });
    return instance;
  }
  _prepareContext(): Record<string, unknown> {
    return {
      isGm: game.user.isGM,
      status: game.user.isGM ? this.#status : "ChatKit currently requires a Foundry GM.",
      providerStatus: chatGptPanelStatus(aiDmController.store.state),
    };
  }
  _onRender(): void {
    if (!game.user.isGM) return;
    this.#providerListeners?.abort();
    this.#providerListeners = new AbortController();
    const select = this.element.querySelector<HTMLSelectElement>("[data-chatgpt-model]");
    if (select?.tagName === "SELECT")
      select.addEventListener(
        "change",
        () => {
          this.providerAction(() => aiDmController.selectChatGptModel(select.value));
        },
        { signal: this.#providerListeners.signal },
      );
    this.updateProviderControls();
    const mount = this.element.querySelector<HTMLElement>(".ai-dm-chatkit-mount");
    if (!mount) return;
    if (this.#component) {
      mount.append(this.#component);
      return;
    }
    this.#mounting ??= this.mount(mount).catch((error) => {
      this.fail(error);
      throw error;
    });
    void this.#mounting.catch(() => undefined);
  }
  private status(text: string): void {
    this.#status = text;
    const node = this.element?.querySelector(".ai-dm-chatkit-status");
    if (node) node.textContent = text;
  }
  private providerAction(action: () => boolean): void {
    if (!game.user.isGM || !action()) {
      const node = this.element?.querySelector(".ai-dm-provider-status");
      if (node)
        node.textContent =
          "Connect as a Foundry GM before changing ChatGPT authorization. Allow popups for sign-in, then try again.";
    }
  }
  private updateProviderControls(): void {
    if (!game.user.isGM) return;
    const state = aiDmController.store.state;
    const status = this.element?.querySelector(".ai-dm-provider-status");
    if (status) status.textContent = chatGptPanelStatus(state);
    const connected = state.connection === "connected" && state.authenticatedLane === "gm";
    for (const action of ["chatGptSignIn", "chatGptRefresh", "chatGptSignOut"]) {
      const button = this.element?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      if (button?.tagName === "BUTTON")
        button.disabled =
          !connected || (action === "chatGptSignOut" && !state.chatGpt.identityConnected);
    }
    const select = this.element?.querySelector<HTMLSelectElement>("[data-chatgpt-model]");
    if (select?.tagName !== "SELECT") return;
    const options = state.chatGpt.availableModels.map((model) => {
      const option = document.createElement("option");
      option.value = model.slug;
      option.textContent = model.displayName;
      option.selected = model.slug === state.chatGpt.selectedModel;
      return option;
    });
    if (!options.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No eligible model available";
      options.push(option);
    } else if (!state.chatGpt.selectedModel) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Choose an eligible model";
      option.selected = true;
      option.disabled = true;
      options.unshift(option);
    }
    select.replaceChildren(...options);
    select.disabled =
      !connected ||
      !state.chatGpt.planUsageAuthorized ||
      !state.chatGpt.availableModels.length ||
      state.chatGpt.modelSelectionPending;
  }
  private fail(error: unknown): void {
    this.#requestFailed = true;
    this.#guard.finish();
    this.status(error instanceof Error ? error.message : "ChatKit request failed.");
  }
  private async mount(mount: HTMLElement): Promise<void> {
    await loadRuntime();
    if (this.#closed) return;
    const domainValue = game.settings.get(MODULE_ID, "chatKitDomainKey");
    const domainKey = chatKitDomainKey(domainValue, globalThis.location?.hostname ?? "");
    if (!domainKey)
      throw new Error(
        "Set the ChatKit domain key in module settings for this Foundry browser origin.",
      );
    this.#threadId = localStorage.getItem(pointerKey());
    const component = document.createElement("openai-chatkit") as OpenAIChatKit;
    this.#listeners = new AbortController();
    const options = { signal: this.#listeners.signal };
    this.#ready = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () =>
          reject(
            new Error(
              "ChatKit did not become ready. Check the registered domain key and CDN access.",
            ),
          ),
        20000,
      );
      component.addEventListener(
        "chatkit.ready",
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { ...options, once: true },
      );
      this.#listeners?.signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timeout);
          reject(new Error("Chat panel closed."));
        },
        { once: true },
      );
    });
    void this.#ready.catch((error) => {
      if (!this.#closed) this.fail(error);
    });
    component.addEventListener(
      "chatkit.thread.change",
      (event) => {
        this.#threadId = event.detail.threadId;
        if (this.#threadId) localStorage.setItem(pointerKey(), this.#threadId);
        else localStorage.removeItem(pointerKey());
      },
      options,
    );
    component.addEventListener(
      "chatkit.response.start",
      () => {
        this.#requestFailed = false;
        this.#guard.busy = true;
        this.status("Receiving response…");
      },
      options,
    );
    component.addEventListener(
      "chatkit.response.end",
      () => {
        this.#guard.finish();
        if (!this.#requestFailed) this.status("Ready");
      },
      options,
    );
    component.addEventListener(
      "chatkit.error",
      () =>
        this.fail(
          new Error(
            "ChatKit could not complete the request. Check connection, Foundry authentication and server configuration.",
          ),
        ),
      options,
    );
    component.setOptions({
      api: { url: gatewayUrl(), domainKey, fetch: this.authenticatedFetch },
      initialThread: this.#threadId,
      frameTitle: "AI Dungeon Master chat",
      theme: "dark",
      composer: { attachments: { enabled: false } },
      history: { enabled: true },
    });
    this.#component = component;
    mount.append(component);
    this.status("Ready. Messages use your private GM conversation.");
  }
  readonly authenticatedFetch: typeof fetch = async (input, init) => {
    if (this.#closed) throw new Error("Chat panel is closed.");
    const destination = new URL(input instanceof Request ? input.url : String(input), gatewayUrl());
    const gateway = new URL(gatewayUrl());
    if (
      destination.origin !== gateway.origin ||
      !["/chatkit", "/chatkit/thread", "/chatkit/actions"].includes(destination.pathname)
    ) {
      throw new Error("Refused to send Foundry authentication outside the ChatKit gateway.");
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    // Frame correlation is local to ChatKit; our authenticated proxy does not forward it.
    headers.delete("chatkit-frame-instance-id");
    const auth = aiDmController.transport.chatKitHeaders?.();
    if (!auth) throw new Error("Foundry authentication is unavailable.");
    for (const [key, value] of Object.entries(auth)) headers.set(key, value);
    const abort = new AbortController();
    this.#requests.add(abort);
    const signal = AbortSignal.any([
      abort.signal,
      ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
    ]);
    try {
      const response = await fetch(input, { ...init, headers, signal });
      if (!response.ok) {
        this.#requests.delete(abort);
        throw new Error(
          response.status === 401
            ? "Foundry authentication expired. Reconnect and try again."
            : response.status === 403
              ? "ChatKit currently requires an authenticated GM."
              : response.status === 409
                ? "A response is already running."
                : response.status === 503
                  ? "ChatKit server or OpenAI authorization is not configured."
                  : "ChatKit server request failed.",
        );
      }
      if (!response.body) {
        this.#requests.delete(abort);
        return response;
      }
      const reader = response.body.getReader();
      const requests = this.#requests;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) {
              requests.delete(abort);
              controller.close();
            } else controller.enqueue(item.value);
          } catch (error) {
            requests.delete(abort);
            controller.error(error);
          }
        },
        async cancel(reason) {
          abort.abort();
          requests.delete(abort);
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      this.#requests.delete(abort);
      this.fail(error);
      throw error;
    }
  };
  async reviewNativeActions(): Promise<void> {
    if (!this.#threadId) {
      this.status("Open a conversation before reviewing actions.");
      return;
    }
    const panel = this.element.querySelector<HTMLElement>(".ai-dm-native-actions");
    if (!panel) return;
    const response = await this.authenticatedFetch(`${gatewayUrl()}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: this.#threadId }),
    });
    const data = (await response.json()) as {
      result: Array<{
        actionId: string;
        kind: string;
        status: string;
        input: { title?: string; text?: string; formula?: string };
        receipt: { total?: number } | null;
      }>;
    };
    panel.replaceChildren();
    for (const action of data.result) {
      const row = document.createElement("section");
      const label = document.createElement("p");
      label.textContent = `${action.kind === "note" ? action.input.title : action.input.formula}: ${action.status}${action.receipt?.total !== undefined ? `, total ${action.receipt.total}` : ""}`;
      row.append(label);
      if (action.kind === "note") {
        const preview = document.createElement("p");
        preview.textContent = action.input.text ?? "";
        row.append(preview);
        if (action.status === "pending")
          for (const choice of ["approve", "reject"] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent =
              choice === "approve" ? "Approve private session journal" : "Reject";
            button.addEventListener("click", () => {
              button.disabled = true;
              void this.authenticatedFetch(`${gatewayUrl()}/actions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  threadId: this.#threadId,
                  actionId: action.actionId,
                  decision: choice,
                }),
              })
                .then(async (response) => {
                  await response.json();
                  await this.reviewNativeActions();
                })
                .catch((error) => {
                  this.fail(error);
                  button.disabled = false;
                });
            });
            row.append(button);
          }
      }
      panel.append(row);
    }
    if (!data.result.length) panel.textContent = "No native actions in this conversation.";
  }
  async trigger(request: ChatKitTrigger): Promise<void> {
    if (!game.user.isGM) throw new Error("ChatKit currently requires a Foundry GM.");
    const prompt = request.prompt?.trim();
    if (!prompt || prompt.length > 4000) throw new Error("Enter a prompt of 1–4000 characters.");
    const context = boundedContext(request.context ?? currentGameContext());
    const requestId = request.requestId ?? crypto.randomUUID();
    if (!this.#guard.start(requestId)) return;
    this.#requestFailed = false;
    this.status("Preparing game-context response…");
    try {
      // Re-rendering detaches the live ChatKit iframe and resets its active conversation.
      if (!this.#component) await Promise.resolve(this.render({ force: true }));
      await this.#mounting;
      await this.#ready;
      if (!this.#component) throw new Error("ChatKit is not ready.");
      if (!this.#threadId) {
        const response = await this.authenticatedFetch(`${gatewayUrl()}/thread`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const data = (await response.json()) as { threadId?: unknown };
        if (typeof data.threadId !== "string")
          throw new Error("Could not initialize the ChatKit conversation.");
        this.#threadId = data.threadId;
        localStorage.setItem(pointerKey(), data.threadId);
        await this.#component.setThreadId(data.threadId);
      }
      await this.#component.sendCustomAction({
        type: "foundry.context-response",
        payload: { requestId, prompt, context },
      });
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.#guard.finish();
    }
  }
  cancel(): void {
    for (const request of this.#requests) request.abort();
    this.#requests.clear();
    this.#guard.finish();
    this.status("Response cancelled.");
  }
  override async close(options: Record<string, unknown> = {}): Promise<void> {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#providerListeners?.abort();
    this.cancel();
    this.#listeners?.abort();
    this.#component?.remove();
    this.#component = null;
    this.#mounting = null;
    AiDungeonMasterApplication.#instance = null;
    await super.close(options);
  }
}
