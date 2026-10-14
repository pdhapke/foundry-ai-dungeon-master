/** Dedicated deterministic player receipts. This component never receives GM context/history. */
import type { ChatKitOptions } from "@openai/chatkit";
export const PLAYER_OBSERVATION_ACTION = "foundry.player-observation";
export interface PlayerSelection { worldId: string; sceneId: string; userId: string; clientId: string; tokenId: string }
export interface SafeChatKitElement extends HTMLElement {
  setOptions(options: ChatKitOptions): void;
  setThreadId(id: string): Promise<void>;
  sendCustomAction(action: unknown): Promise<void>;
}
interface Player { id: string; name?: string; active?: boolean; isGM?: boolean; query?: (name: string, payload: unknown, options: unknown) => Promise<unknown> }
interface Token { id?: string; document?: { id?: string; testUserPermission?: (user: Player, permission: string) => boolean; toObject?: () => unknown } }
export interface ObservationEnvironment {
  worldId: string; gmId: string; isGM: boolean; sceneId?: string | undefined; token?: Token | undefined; players: Player[]; revision: string;
}
export function currentObservationEnvironment(): ObservationEnvironment {
  const runtime = game as unknown as { users?: { contents?: Player[] }; user: { id: string; isGM: boolean }; world?: { id?: string } };
  const view = canvas as unknown as { scene?: { id?: string; toObject?: () => unknown }; tokens?: { controlled?: Token[] } } | undefined;
  const selected = view?.tokens?.controlled;
  return { worldId: runtime.world?.id ?? "", gmId: runtime.user.id, isGM: runtime.user.isGM, sceneId: view?.scene?.id,
    token: selected?.length === 1 ? selected[0] : undefined, players: runtime.users?.contents ?? [],
    // Request-local lifetime fence only. Never transmitted or exposed as a public receipt.
    revision: JSON.stringify({ scene: view?.scene?.toObject?.() ?? null, token: selected?.length === 1 ? selected[0]?.document?.toObject?.() ?? null : null }),
  };
}
export function owningPlayers(environment: ObservationEnvironment): Player[] {
  return environment.players.filter(user => user.active && !user.isGM && environment.token?.document?.testUserPermission?.(user, "OWNER") === true);
}
const selectionKeys = ["worldId", "sceneId", "userId", "clientId", "tokenId"] as const;
export function safePlayerOperation(body: unknown, threadId: string | null, selection: PlayerSelection, armedRequest: string | null): boolean {
  if (!body || typeof body !== "object" || !threadId) return false;
  const request = body as { type?: unknown; params?: Record<string, unknown> };
  const params = request.params;
  if (!params || params.thread_id !== threadId) return false;
  if (request.type === "threads.get_by_id" || request.type === "items.list") return true;
  if (request.type !== "threads.custom_action" || !armedRequest) return false;
  const action = params.action as { type?: unknown; payload?: Record<string, unknown> } | undefined;
  if (action?.type !== PLAYER_OBSERVATION_ACTION || !action.payload) return false;
  const payload = action.payload;
  return Object.keys(payload).length === 6 && payload.requestId === armedRequest && selectionKeys.every(key => payload[key] === selection[key]);
}

interface PanelDependencies {
  gatewayUrl: string; domainKey: string; authHeaders: () => Record<string, string> | undefined;
  environment?: () => ObservationEnvironment; fetch?: typeof fetch;
}
export function waitForPlayerFrame(component: HTMLElement, signal: AbortSignal, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const finish = (error?: Error) => { clearTimeout(timer); listeners.abort(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(Error("Player chat frame did not become ready. Check ChatKit domain registration and CDN access, then reopen this panel.")), timeoutMs);
    component.addEventListener("chatkit.ready", () => finish(), { once: true, signal: listeners.signal });
    component.addEventListener("chatkit.error", () => finish(Error("Player chat frame could not initialize. Check ChatKit domain registration and CDN access, then reopen this panel.")), { once: true, signal: listeners.signal });
    signal.addEventListener("abort", () => finish(Error("Player observation panel closed.")), { once: true, signal: listeners.signal });
    if (signal.aborted) finish(Error("Player observation panel closed."));
  });
}
export function waitForPlayerThread(component: HTMLElement, threadId: string, signal: AbortSignal, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const finish = (error?: Error) => { clearTimeout(timer); listeners.abort(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(Error("Dedicated player history did not finish loading.")), timeoutMs);
    component.addEventListener("chatkit.thread.load.end", event => {
      if ((event as CustomEvent<{threadId:string}>).detail?.threadId === threadId) finish();
    }, { signal: listeners.signal });
    component.addEventListener("chatkit.error", () => finish(Error("Dedicated player history could not load.")), { once:true,signal:listeners.signal });
    signal.addEventListener("abort", () => finish(Error("Player observation panel closed.")), { once:true,signal:listeners.signal });
    if (signal.aborted) finish(Error("Player observation panel closed."));
  });
}
export class PlayerObservationPanel {
  #diagnostic = { phase: "idle", operation: "none", failure: "none" };
  get diagnostic(): Readonly<{ phase: string; operation: string; failure: string }> { return { ...this.#diagnostic }; }
  #lifetime = new AbortController();
  #requests = new Set<AbortController>();
  #component: SafeChatKitElement | null = null;
  #threadId: string | null = null;
  #selection: PlayerSelection | null = null;
  #armed: string | null = null;
  #baseline: ObservationEnvironment;
  #playerId: string | null = null;
  #busy = false;
  #status: HTMLElement;
  #mount: HTMLElement;
  #button: HTMLButtonElement;
  #environment: () => ObservationEnvironment;
  #hooks: Array<{ event: string; id: number }> = [];
  constructor(private host: HTMLElement, private deps: PanelDependencies) {
    this.#environment = deps.environment ?? currentObservationEnvironment;
    this.#baseline = { ...this.#environment() };
    host.replaceChildren(); host.hidden = false;
    this.#status = document.createElement("p"); this.#status.setAttribute("role", "status");
    this.#mount = document.createElement("div"); this.#mount.className = "ai-dm-chatkit-mount"; this.#mount.style.height = "320px";
    const picker = document.createElement("select"); picker.setAttribute("aria-label", "Observing player");
    const owners = owningPlayers(this.#baseline);
    for (const owner of owners) { const option = document.createElement("option"); option.value = owner.id; option.textContent = owner.name ?? "Player"; picker.append(option); }
    this.#playerId = owners[0]?.id ?? null;
    this.#button = document.createElement("button"); this.#button.type = "button"; this.#button.textContent = "Describe surroundings";
    this.#button.disabled = !this.#baseline.isGM || !this.#baseline.token || owners.length === 0;
    this.#status.textContent = this.#button.disabled ? "Select one token owned by an active player, then reopen Player surroundings." : "Player observations only. This uses no model calls.";
    const close = document.createElement("button"); close.type = "button"; close.textContent = "Close player observations";
    host.append(picker, this.#button, close, this.#status, this.#mount);
    picker.addEventListener("change", () => {
      this.#playerId = picker.value;
      if (this.#component || this.#busy) { this.cancel(); this.#status.textContent = "Player changed. Reopen Player surroundings to start a new observation history."; }
    }, { signal: this.#lifetime.signal });
    close.addEventListener("click", () => { this.cancel(); host.hidden = true; }, { signal: this.#lifetime.signal });
    this.#button.addEventListener("click", () => { void this.observe().catch(() => undefined); }, { signal: this.#lifetime.signal });
    const hooks = (globalThis as unknown as { Hooks?: { on: (event: string, fn: () => void) => number; off: (event: string, id: number) => void } }).Hooks;
    if (typeof hooks?.on === "function" && typeof hooks?.off === "function") for (const event of ["canvasReady", "controlToken", "updateToken", "updateScene", "updateUser", "deleteToken", "deleteScene"]) {
      this.#hooks.push({ event, id: hooks.on(event, () => { try { this.#current(); } catch { this.#status.textContent = "World, player, or token changed. Reopen Player surroundings for current observations."; } }) });
    }
  }
  #current(): void {
    this.#lifetime.signal.throwIfAborted();
    const now = this.#environment(), before = this.#baseline;
    const tokenId = before.token?.document?.id ?? before.token?.id;
    if (!now.isGM || now.worldId !== before.worldId || now.gmId !== before.gmId || now.sceneId !== before.sceneId ||
        (now.token?.document?.id ?? now.token?.id) !== tokenId || now.revision !== before.revision ||
        !owningPlayers(now).some(p => p.id === this.#playerId)) {
      this.cancel(); throw Error("Player observation lifetime changed");
    }
  }
  cancel(): void {
    this.#lifetime.abort(); for (const request of this.#requests) request.abort(); this.#requests.clear();
    this.#component?.remove(); this.#component = null; this.#threadId = null; this.#selection = null; this.#armed = null;
    this.#button.disabled = true; this.#mount.replaceChildren();
    const hooks = (globalThis as unknown as { Hooks?: { off: (event: string, id: number) => void } }).Hooks;
    for (const hook of this.#hooks) hooks?.off(hook.event, hook.id); this.#hooks = [];
  }
  async #request(input: RequestInfo | URL, init?: RequestInit, bootstrap = false): Promise<Response> {
    this.#current();
    const gateway = new URL(this.deps.gatewayUrl), target = new URL(input instanceof Request ? input.url : String(input), gateway);
    if (target.origin !== gateway.origin || target.pathname !== `${gateway.pathname}${bootstrap ? "/thread" : ""}` || (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST") { this.#diagnostic.failure = "UNSUPPORTED_RECEIPT_ROUTE"; throw Error("Unsupported player receipt route"); }
    const raw = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "";
    const body = JSON.parse(raw);
    this.#diagnostic.operation = bootstrap ? "bootstrap" : ["threads.get_by_id", "items.list", "threads.custom_action"].includes(body?.type) ? body.type : "unsupported";
    if (!bootstrap && (!this.#selection || !safePlayerOperation(body, this.#threadId, this.#selection, this.#armed))) { this.#diagnostic.failure = "RECEIPT_POLICY_DENIED"; throw Error("Player component cannot invoke inference or GM history"); }
    const auth = this.deps.authHeaders(); if (!auth) throw Error("Foundry authentication unavailable");
    const headers = new Headers({ "content-type": "application/json", ...auth });
    const controller = new AbortController(); this.#requests.add(controller);
    const signal = AbortSignal.any([this.#lifetime.signal, controller.signal, ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : [])]);
    try {
      const response = await (this.deps.fetch ?? fetch)(target, { method: "POST", body: raw, headers, signal }); this.#current();
      if (!response.ok) { this.#diagnostic.failure = "RECEIPT_HTTP_REJECTED"; throw Error("Player receipt request unavailable"); }
      if (!response.body) { this.#requests.delete(controller); return response; }
      const reader = response.body.getReader(), panel = this;
      return new Response(new ReadableStream({ async pull(stream) {
        try { panel.#current(); const next = await reader.read(); panel.#current(); if (next.done) { panel.#requests.delete(controller); stream.close(); } else stream.enqueue(next.value); }
        catch (error) { controller.abort(); panel.#requests.delete(controller); await reader.cancel().catch(() => undefined); stream.error(error); }
      }, async cancel() { controller.abort(); panel.#requests.delete(controller); await reader.cancel(); } }), { status: response.status, headers: response.headers });
    } catch (error) { this.#requests.delete(controller); throw error; }
  }
  async observe(): Promise<void> {
    this.#current(); if (this.#busy) return;
    this.#busy = true; this.#button.disabled = true;
    let stage: "player" | "thread" | "frame" | "history" | "receipt" = "player";
    this.#diagnostic = { phase: "player", operation: "none", failure: "none" };
    try {
      const user = this.#environment().players.find(p => p.id === this.#playerId);
      if (!user?.query) throw Error("Supported Foundry User.query unavailable");
      this.#status.textContent = "Checking the player's connection and consent…";
      const probe = await user.query("foundry-local-api.bridgeEnrollment", { action: "probe", targetUserId: user.id, expectedLane: "player" }, { timeout: 5000 }) as Record<string, unknown>;
      this.#current();
      const diagnostics = probe.diagnostics as { connectionState?: unknown } | undefined;
      if (probe.moduleLoaded !== true || probe.userId !== user.id || probe.intendedLane !== "player" || probe.consentGranted !== true || diagnostics?.connectionState !== "connected" || typeof probe.clientId !== "string" || !/^[0-9a-f-]{36}$/i.test(probe.clientId)) throw Error("Exact consenting player not connected");
      const selection = { worldId: this.#baseline.worldId, sceneId: this.#baseline.sceneId!, userId: user.id, clientId: probe.clientId, tokenId: (this.#baseline.token?.document?.id ?? this.#baseline.token?.id)! };
      if (this.#selection && selectionKeys.some(key => this.#selection![key] !== selection[key])) { this.cancel(); throw Error("Player audience changed"); }
      if (!this.#component) {
        stage = "thread";
        this.#diagnostic.phase = stage;
        this.#selection = selection;
        const response = await this.#request(`${this.deps.gatewayUrl}/thread`, { method: "POST", body: JSON.stringify({ playerObservation: selection }) }, true);
        const data = await response.json(); this.#current();
        if (typeof data.threadId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.threadId)) throw Error("Dedicated thread unavailable");
        this.#threadId = data.threadId;
        const component = document.createElement("openai-chatkit") as SafeChatKitElement; this.#component = component;
        stage = "frame";
        this.#diagnostic.phase = stage;
        component.style.display = "block"; component.style.width = "100%"; component.style.height = "100%";
        const frameLifetime = new AbortController();
        const initializationSignal = AbortSignal.any([this.#lifetime.signal, frameLifetime.signal]);
        const ready = waitForPlayerFrame(component, initializationSignal);
        // Frame readiness does not establish thread readiness. Listen before
        // setOptions because initialThread can finish before chatkit.ready.
        const loaded = waitForPlayerThread(component, this.#threadId!, initializationSignal);
        void ready.catch(() => undefined);
        void loaded.catch(() => undefined);
        component.addEventListener("chatkit.error", () => { if (this.#diagnostic.failure === "none") this.#diagnostic.failure = "CHATKIT_COMPONENT_ERROR"; this.#status.textContent = "Player receipt unavailable. No model request is permitted here."; }, { signal: this.#lifetime.signal });
        try {
          component.setOptions({ api: { url: this.deps.gatewayUrl, domainKey: this.deps.domainKey, fetch: (input: RequestInfo | URL, init?: RequestInit) => this.#request(input, init) }, initialThread: this.#threadId,
            frameTitle: "Player surroundings", theme: "dark", header: { enabled: false }, history: { enabled: false }, composer: { placeholder: "Use Describe surroundings above", attachments: { enabled: false } } });
          this.#mount.append(component); await ready; this.#current(); stage = "history"; this.#diagnostic.phase = stage; await loaded; this.#current();
        } catch (error) {
          component.remove(); this.#component = null; this.#threadId = null; this.#selection = null;
          throw error;
        } finally { frameLifetime.abort(); }
      }
      stage = "receipt";
      this.#diagnostic.phase = stage;
      this.#armed = crypto.randomUUID();
      this.#status.textContent = "Reading validated player observations…";
      await this.#component.sendCustomAction({ type: PLAYER_OBSERVATION_ACTION, payload: { requestId: this.#armed, ...selection } });
      this.#current(); this.#status.textContent = "Player observation receipt received. Unknown threats and trap outcomes remain unknown.";
      this.#diagnostic.phase = "complete";
    } catch (error) {
      if (this.#diagnostic.failure === "none") this.#diagnostic.failure = "PLAYER_COMPONENT_STEP_REJECTED";
      this.#status.setAttribute("data-player-observation-phase", this.#diagnostic.phase);
      this.#status.setAttribute("data-player-observation-operation", this.#diagnostic.operation);
      this.#status.setAttribute("data-player-observation-failure", this.#diagnostic.failure);
      if (!this.#lifetime.signal.aborted) this.#status.textContent = stage === "frame" ? "Player chat frame unavailable. Check ChatKit domain registration and CDN access, then reopen this panel." : stage === "thread" || stage === "history" ? "Dedicated player history unavailable. Check Foundry authentication and server connection, then reopen this panel." : stage === "receipt" ? "Player observation receipt unavailable. Recheck the selected player's connection and consent." : "Selected player unavailable. Check connection, consent, and token ownership, then reopen this panel.";
      throw error;
    } finally { this.#armed = null; this.#busy = false; if (!this.#lifetime.signal.aborted) this.#button.disabled = false; }
  }
}
