type PanelElement = HTMLElement & {
    value: string;
    disabled: boolean;
    checked: boolean;
};
interface ChatKitElement extends HTMLElement {
    setOptions(options: unknown): void;
    setThreadId(id: string): Promise<void>;
    sendCustomAction(action: unknown): Promise<void>;
}
var __defProp = Object.defineProperty;
var __name = <T extends object>(target: T, value: string): T => __defProp(target, "name", { value, configurable: true });
import { CHATKIT_INFERENCE_OPERATIONS, supportedChatKitOperation } from "@foundry-ai-dungeon-master/shared";
import { aiDmController } from "./controller.js";
import { compactPanelState, compactStatusMessage } from "./compact-panel.js";
import { chatKitDomainKey } from "./chatkit-domain.js";
import { validateCampaignReview, campaignReceiptText } from "./campaign-review.js";
import { validateWorldReview } from "./world-review.js";
import { cancelAutomaticEventLifecycle } from "./automatic-triggers.js";
import { BrowserLatencyProbe, latencyDownloadButton } from "./latency-probe.js";
import { parseCoreCommand } from "./core-command.js";
import type { ChatKitTrigger } from "./chatkit-context.js";
import { boundedContext, currentGameContext, TriggerGuard } from "./chatkit-context.js";
import { PanelPreparation } from "./panel-preparation.js";
import { PlayerObservationPanel } from "./player-observation-panel.js";
import { CampaignPreparationPanel } from "./preparation-panel.js";
import { ForestBattlemapPanel } from "./forest-battlemap-panel.js";
const MODULE_ID = "foundry-ai-dungeon-master";
const RUNTIME_URL = "https://cdn.platform.openai.com/deployments/chatkit/chatkit.js";
async function cancellable(work: any, signal: any) { const promise = Promise.resolve(work); if (signal.aborted) {
    void promise.catch(() => { });
    signal.throwIfAborted();
} let stop = __name(() => { }, "stop"); const stopped = new Promise<void>((_: any, reject: any) => { stop = __name(() => reject(signal.reason instanceof Error ? signal.reason : new Error("Response cancelled.")), "stop"); signal.addEventListener("abort", stop, { once: true }); }); try {
    return await Promise.race([promise, stopped]);
}
finally {
    signal.removeEventListener("abort", stop);
} }
__name(cancellable, "cancellable");
let runtimePromise: Promise<void> | undefined;
function loadRuntime() { if (customElements.get("openai-chatkit"))
    return Promise.resolve(); if (!runtimePromise)
    runtimePromise = new Promise<void>((resolve: any, reject: any) => { const script = document.createElement("script"); script.src = RUNTIME_URL; script.async = true; script.addEventListener("load", () => { void customElements.whenDefined("openai-chatkit").then(() => resolve()); }, { once: true }); script.addEventListener("error", () => { runtimePromise = void 0; script.remove(); reject(new Error("ChatKit could not load. Check network access to the OpenAI CDN.")); }, { once: true }); document.head.append(script); }); return runtimePromise; }
__name(loadRuntime, "loadRuntime");
function gatewayUrl() { const url = new URL(String(game.settings.get(MODULE_ID, "serverUrl"))); url.protocol = url.protocol === "wss:" ? "https:" : "http:"; return `${url.origin}/chatkit`; }
__name(gatewayUrl, "gatewayUrl");
function pointerKey() { return `${MODULE_ID}.chatkit.thread.${game.world?.id ?? "none"}.${game.user.id}`; }
__name(pointerKey, "pointerKey");
const Base = foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);
class AiDungeonMasterApplication extends Base {
    static { __name(this, "AiDungeonMasterApplication"); }
    static DEFAULT_OPTIONS = { id: MODULE_ID, classes: [MODULE_ID], tag: "div", position: { width: 620, height: 720 }, window: { title: "AI Dungeon Master", resizable: true, minimizable: true }, actions: { contextResponse: __name(() => { void this.#instance?.trigger({ prompt: "Describe the current game situation using the supplied context.", context: currentGameContext() }).catch((error: any) => this.#instance?.fail(error)); }, "contextResponse"), resolveAction: __name(() => { void this.#instance?.trigger({ prompt: "Resolve the selected player action using current authorized state. If the player's intent is unclear, ask for it. Use only permitted native tools; request confirmation for persistent session notes and never claim an unexecuted action." }).catch((error: any) => this.#instance?.fail(error)); }, "resolveAction"), cancelResponse: __name(() => this.#instance?.cancel(), "cancelResponse"), reviewNativeActions: __name(() => { void this.#instance?.reviewActions().catch((error: any) => this.#instance?.fail(error)); }, "reviewNativeActions"), chatGptSignIn: __name(() => this.#instance?.providerAction(() => aiDmController.beginChatGptSignIn()), "chatGptSignIn"), chatGptRefresh: __name(() => { this.#instance?.recoverConnection(); }, "chatGptRefresh"), chatGptSignOut: __name(() => this.#instance?.providerAction(() => aiDmController.signOutChatGpt()), "chatGptSignOut") } };
    static PARTS = { main: { template: `modules/${MODULE_ID}/module/templates/ai-dungeon-master/application.hbs` } };
    static #instance: AiDungeonMasterApplication | null = null;
    #component: ChatKitElement | null = null;
    #playerObservationPanel: PlayerObservationPanel | null = null;
    #campaignPreparationPanel: CampaignPreparationPanel | null = null;
    #forestBattlemapPanel: ForestBattlemapPanel | null = null;
    #forestBudget: {threadId:string;traceId:string;expiresAt:string}|null=null;
    #latencyProbe: BrowserLatencyProbe | null = null;
    #mounting: Promise<void> | null = null;
    #mountGeneration = 0;
    #ready: Promise<void> | null = null;
    #listeners: AbortController | null = null;
    #requests = new Set<AbortController>;
    #guard = new TriggerGuard;
    #queuedTriggers = 0;
    #responseActive = false;
    #idleWaiters = new Set<() => void>;
    #triggerTail = Promise.resolve();
    #triggerGeneration = 0;
    #triggerCancellation = new AbortController;
    #dispatchCancellation: AbortSignal | null = null;
    #closed = false;
    #threadId: string | null = null;
    #threadSelection: {
        id: string;
        generation: number;
    } | null = null;
    #preparationStatus = "Preparing prerequisites…";
    #preparationKey = "";
    #preparation = new PanelPreparation(async (signal) => {
        const auth = aiDmController.transport.chatKitHeaders?.();
        if (!auth) throw new Error("Reconnect required. Foundry authentication is unavailable.");
        return fetch(`${gatewayUrl()}/prepare`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}", signal });
    }, ({ message }) => { this.#preparationStatus = message; if (!this.#closed && !this.#requestFailed && !this.#responseActive && !this.#guard.busy) this.status(message); });
    refreshPreparation() {
        if (this.#closed || this.#configurationChanged) return;
        const state = aiDmController.store.state;
        if (game.user.isGM && game.world?.id === this.#worldId && game.user.id === this.#userId && state.connection === "connected" && state.authenticatedLane === "gm" && state.chatGpt.state === "ready" && !state.chatGpt.modelSelectionPending)
            void this.#preparation.refresh().catch(() => void 0);
        else this.checkPreparation();
    }
    recoverConnection() {
        if (this.#closed || !game.user.isGM) return;
        if (this.#configurationChanged) { this.fail(new Error(this.#configurationChanged)); return; }
        if (aiDmController.store.state.connection !== "connected" || aiDmController.store.state.authenticatedLane !== "gm") {
            aiDmController.reconnect();
            this.status("Reconnecting Foundry authentication. No model request was sent.");
            return;
        }
        this.refreshPreparation();
        this.providerAction(() => aiDmController.refreshChatGptStatus());
    }
    checkPreparation() {
        if (this.#closed || this.#configurationChanged || !this.element) return;
        const state = aiDmController.store.state;
        const key = JSON.stringify([game.world?.id, game.user.id, game.user.isGM, state.connection, state.authenticatedLane, state.chatGpt.selectedModel, state.chatGpt.state, state.chatGpt.modelSelectionPending]);
        if (key === this.#preparationKey) return;
        this.#preparationKey = key;
        this.#preparation.invalidate();
        if (game.user.isGM && (game.world?.id ?? "none") === this.#worldId && game.user.id === this.#userId && state.connection === "connected" && state.authenticatedLane === "gm" && state.chatGpt.state === "ready" && !state.chatGpt.modelSelectionPending)
            void this.#preparation.ensure().catch(() => void 0);
    }
    #status = "Connecting to ChatKit\u2026";
    #requestFailed = false;
    #configurationChanged = "";
    #statusConnection = "";
    #unsubscribe: (() => void) | null = null;
    #providerListeners: AbortController | null = null;
    #reviewEpoch = 0;
    #reviewBatch: { key: string; promise: Promise<void> } | null = null;
    #campaignLoadGeneration = 0;
    #worldLoadGeneration = { world: 0, "world-file": 0 };
    #campaignListeners: AbortController | null = null;
    #worldId = game.world?.id ?? "none";
    #userId = game.user.id;
    constructor(options: any = {}) { super(options); this.#unsubscribe = aiDmController.store.subscribe(() => { if (!this.#closed)
        { const state = aiDmController.store.state;
          const connection = `${state.connection}:${state.authenticatedLane}`;
          if (connection !== this.#statusConnection) {
            this.#statusConnection = connection;
            if (state.connection === "connected" && state.authenticatedLane === "gm" && !this.#configurationChanged) aiDmController.openStatusPanel();
          }
          this.updateProviderControls(); this.checkPreparation(); } }); }
    static open() { const instance = this.#instance ?? new this; this.#instance = instance; if (!instance.#component)
        instance.render({ force: true }); return instance; }
    static settingsChanged(key = "configuration") {
        const panel = this.#instance;
        if (!panel || panel.#closed) return;
        panel.updateDiagnostics();
        if (key === "latencyDiagnosticsEnabled") return;
        panel.cancel();
        aiDmController.closeStatusPanel();
        panel.#configurationChanged = key === "serverUrl"
            ? "Server settings changed. Reopen the DM panel after Foundry authentication reconnects. No model request was sent."
            : "ChatKit settings changed. Reopen the DM panel to validate this browser configuration.";
        if (key === "serverUrl") aiDmController.reconnect();
        panel.fail(new Error(panel.#configurationChanged));
    }
    static cancelOpen() { this.#instance?.cancel(); }
    async openPlayerObservations() {
        this.#playerObservationPanel?.cancel(); this.#playerObservationPanel = null;
        await loadRuntime();
        if (this.#closed || !game.user.isGM || (game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId) return;
        const host = this.element.querySelector<HTMLElement>(".ai-dm-player-observations");
        const domainKey = chatKitDomainKey(game.settings.get(MODULE_ID, "chatKitDomainKey"), globalThis.location?.hostname ?? "");
        if (!host || !domainKey) throw Error("Player observation panel requires the registered ChatKit browser origin.");
        (this.#playerObservationPanel as PlayerObservationPanel | null)?.cancel();
        this.#playerObservationPanel = new PlayerObservationPanel(host, { gatewayUrl: gatewayUrl(), domainKey, authHeaders: () => aiDmController.transport.chatKitHeaders?.() });
    }
    updateStopControl() { const button = this.element?.querySelector<PanelElement>('[data-action="cancelResponse"]'); if (button?.tagName === "BUTTON") button.hidden = !(this.#guard.busy || this.#responseActive || this.#queuedTriggers > 0); }
    showReviewDrawer() { const drawer = this.element?.querySelector<HTMLDetailsElement>(".ai-dm-review-drawer"); if (drawer?.tagName === "DETAILS") { drawer.hidden = false; drawer.open = true; } }
    updateDiagnostics() { const host = this.element?.querySelector<HTMLElement>(".ai-dm-diagnostics"); if (host?.tagName !== "DIV") return; const enabled = game.settings.get(MODULE_ID, "latencyDiagnosticsEnabled") === true; host.hidden = !enabled; if (!enabled) host.replaceChildren(); else if (!host.querySelector(".ai-dm-latency-export")) host.append(latencyDownloadButton()); }
    finishGuard() { this.#guard.finish(); this.updateStopControl(); for (const wake of this.#idleWaiters)
        wake(); this.#idleWaiters.clear(); }
    async waitForIdle(signal: AbortSignal) { while (this.#guard.busy) {
        let wake = __name(() => { }, "wake");
        const idle = new Promise<void>((resolve: any) => { wake = resolve; this.#idleWaiters.add(wake); });
        try {
            await cancellable(idle, signal);
        }
        finally {
            this.#idleWaiters.delete(wake);
        }
    } }
    _prepareContext() { return { isGm: game.user.isGM, isTestWorld:game.world?.id==='mcp-test', status: game.user.isGM ? compactStatusMessage(this.#status) : "ChatKit currently requires a Foundry GM.", providerStatus: compactPanelState(aiDmController.store.state).providerMessage }; }
    _onRender() { this.checkPreparation(); this.#playerObservationPanel?.cancel(); this.#playerObservationPanel = null; if (!game.user.isGM)
        return; this.#providerListeners?.abort(); this.#providerListeners = new AbortController;
        if (!this.#configurationChanged) aiDmController.openStatusPanel();
        const accountMenu = this.element.querySelector<HTMLDetailsElement>(".ai-dm-account-menu");
        if (accountMenu?.tagName === "DETAILS") accountMenu.addEventListener("keydown", (event) => { if (event.key === "Escape") { accountMenu.open = false; accountMenu.querySelector<HTMLElement>("summary")?.focus(); event.stopPropagation(); } }, { signal: this.#providerListeners.signal });
        const setupButton = this.element.querySelector<HTMLButtonElement>('[data-campaign-setup]');
        const forestButton=this.element.querySelector<HTMLButtonElement>('[data-forest-map]');
        if(forestButton?.tagName==='BUTTON')forestButton.addEventListener('click',()=>{void this.openForestMap().catch(()=>this.status('Forest test map unavailable. Reconnect the intended test GM.'));},{signal:this.#providerListeners.signal});
        if (setupButton?.tagName === 'BUTTON') setupButton.addEventListener('click', () => { void this.openCampaignSetup().catch(() => this.status('Campaign setup unavailable. Reconnect the intended GM client.')); }, { signal: this.#providerListeners.signal });
        const playerButton = this.element.querySelector<PanelElement>("[data-player-surroundings]");
        if (playerButton?.tagName === "BUTTON") playerButton.addEventListener("click", () => { void this.openPlayerObservations().catch(() => this.status("Player observations unavailable. Check the current token and registered ChatKit origin.")); }, { signal: this.#providerListeners.signal });
        const select = this.element.querySelector<PanelElement>("[data-chatgpt-model]"); if (select?.tagName === "SELECT")
        select.addEventListener("change", () => { this.providerAction(() => aiDmController.selectChatGptModel(select.value)); }, { signal: this.#providerListeners.signal }); this.updateProviderControls(); const mount = this.element.querySelector<PanelElement>(".ai-dm-chatkit-mount"); if (!mount)
        return; if (this.#component) {
        mount.append(this.#component);
        this.updateDiagnostics();
        return;
    } this.#mounting ??= this.mount(mount).catch((error: any) => { this.fail(error); throw error; }); void this.#mounting.catch(() => void 0); }
    status(text: string) { this.#status = text; const node = this.element?.querySelector<PanelElement>(".ai-dm-chatkit-status"); if (node)
        { node.textContent = compactStatusMessage(text); node.hidden = !node.textContent; } this.updateStopControl(); }
    providerAction(action: any) { if (!game.user.isGM || !action()) {
        this.fail(new Error("Connect as a Foundry GM before changing ChatGPT authorization. Allow popups for sign-in, then try again."));
    } }
    updateProviderControls() { if (!game.user.isGM)
        return; const state = aiDmController.store.state; const status = this.element?.querySelector<PanelElement>(".ai-dm-provider-status"); if (status)
        { status.textContent = compactPanelState(state).providerMessage; status.hidden = !status.textContent; } const presentation = compactPanelState(state); const signIn = this.element?.querySelector<PanelElement>('[data-action="chatGptSignIn"]'); if (signIn?.tagName === "BUTTON") { signIn.hidden = !presentation.showSignIn; signIn.textContent = presentation.signInLabel; } const reconnect = this.element?.querySelector<HTMLElement>(".ai-dm-reconnection"); if (reconnect?.tagName === "DIV") reconnect.hidden = !presentation.providerMessage && !presentation.showSignIn; this.updateDiagnostics(); this.updateStopControl(); const connected = state.connection === "connected" && state.authenticatedLane === "gm"; for (const action of ["chatGptSignIn", "chatGptRefresh", "chatGptSignOut"]) {
        const button = this.element?.querySelector<PanelElement>(`[data-action="${action}"]`);
        if (button?.tagName === "BUTTON")
            button.disabled = action === "chatGptRefresh" ? false : !connected || action === "chatGptSignOut" && !state.chatGpt.identityConnected;
    } const select = this.element?.querySelector<PanelElement>("[data-chatgpt-model]"); if (select?.tagName !== "SELECT")
        return; const options = state.chatGpt.availableModels.map((model: any) => { const option = document.createElement("option"); option.value = model.slug; option.textContent = model.displayName; option.selected = model.slug === state.chatGpt.selectedModel; return option; }); if (!options.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No eligible model available";
        options.push(option);
    }
    else if (!state.chatGpt.selectedModel) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "Choose an eligible model";
        option.selected = true;
        option.disabled = true;
        options.unshift(option);
    } select.replaceChildren(...options); select.disabled = !connected || !state.chatGpt.planUsageAuthorized || !state.chatGpt.availableModels.length || state.chatGpt.modelSelectionPending; }
    fail(error: unknown) { this.#responseActive = false; this.#requestFailed = true; this.finishGuard(); this.status(error instanceof Error ? error.message : "ChatKit request failed."); }
    async mount(mount: HTMLElement) { const generation = ++this.#mountGeneration; await loadRuntime(); if (this.#closed || generation !== this.#mountGeneration || (game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId)
        return; const domainValue = game.settings.get(MODULE_ID, "chatKitDomainKey"); const domainKey = chatKitDomainKey(domainValue, globalThis.location?.hostname ?? ""); if (!domainKey)
        throw new Error("Set the ChatKit domain key in module settings for this Foundry browser origin."); const threadPointer = `${MODULE_ID}.chatkit.thread.${this.#worldId}.${this.#userId}`; this.#threadId = localStorage.getItem(threadPointer); const component = document.createElement("openai-chatkit") as ChatKitElement; this.#listeners = new AbortController; const options = { signal: this.#listeners.signal }; this.#ready = new Promise<void>((resolve: any, reject: any) => { const timeout = window.setTimeout(() => reject(new Error("ChatKit did not become ready. Check the registered domain key and CDN access.")), 20000); component.addEventListener("chatkit.ready", () => { window.clearTimeout(timeout); resolve(); }, { ...options, once: true }); this.#listeners?.signal.addEventListener("abort", () => { window.clearTimeout(timeout); reject(new Error("Chat panel closed.")); }, { once: true }); }); void this.#ready.catch((error: any) => { if (!this.#closed)
        this.fail(error); }); component.addEventListener("chatkit.thread.change", (event: any) => { if (this.#closed || generation !== this.#mountGeneration || this.#component !== component || (game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId)
        return; if (this.#threadSelection?.id === event.detail.threadId && this.#threadSelection!.generation !== this.#triggerGeneration)
        return; this.invalidateReviews(); this.#threadId = event.detail.threadId; if (this.#threadId)
        localStorage.setItem(threadPointer, this.#threadId);
    else
        localStorage.removeItem(threadPointer); this.checkPendingReviews(); }, options); component.addEventListener("chatkit.response.start", () => { this.#requestFailed = false; this.#responseActive = true; this.#guard.busy = true; this.status("Receiving response\u2026"); }, options); component.addEventListener("chatkit.response.end", () => { this.#latencyProbe?.mark("browser-chatkit-response-end"); this.#responseActive = false; this.finishGuard(); this.checkPendingReviews(); if (!this.#requestFailed)
        this.status(this.#preparationStatus); }, options); component.addEventListener("chatkit.error", () => this.fail(new Error("ChatKit could not complete the request. Check connection, Foundry authentication and server configuration.")), options); component.setOptions({ api: { url: gatewayUrl(), domainKey, fetch: this.authenticatedFetch }, initialThread: this.#threadId, frameTitle: "AI Dungeon Master chat", theme: "dark", composer: { attachments: { enabled: false } }, history: { enabled: true } }); this.#component = component; mount.append(component); this.updateDiagnostics(); this.checkPreparation(); void this.#ready.then(() => { if (!this.#closed && this.#component === component && generation === this.#mountGeneration) this.checkPendingReviews(); }).catch(() => void 0); }
    authenticatedFetch = __name(async (input: RequestInfo | URL, init?: RequestInit) => { const cancellation = AbortSignal.any([this.#triggerCancellation.signal, ...this.#dispatchCancellation ? [this.#dispatchCancellation] : []]); cancellation.throwIfAborted(); if (this.#closed)
        throw new Error("Chat panel is closed."); if (this.#configurationChanged) throw new Error(this.#configurationChanged); if ((game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId) {
        this.cancel();
        throw new Error("World or player changed. Reopen the dungeon master panel.");
    } const destination = new URL(input instanceof Request ? input.url : String(input), gatewayUrl()); const gateway = new URL(gatewayUrl()); if (destination.origin !== gateway.origin || !["/chatkit", "/chatkit/thread", "/chatkit/actions"].includes(destination.pathname)) {
        throw new Error("Refused to send Foundry authentication outside the ChatKit gateway.");
    } const headers = new Headers(input instanceof Request ? input.headers : void 0); new Headers(init?.headers).forEach((value: any, key: any) => headers.set(key, value)); headers.delete("chatkit-frame-instance-id"); const auth = aiDmController.transport.chatKitHeaders?.(); if (!auth)
        throw new Error("Foundry authentication is unavailable."); for (const [key, value] of Object.entries(auth))
        headers.set(key, value); let latency: BrowserLatencyProbe | undefined; let pendingKey: string | undefined; const rawBody = typeof init?.body === "string" ? init.body : void 0; if (destination.pathname === "/chatkit" && rawBody) {
        const operation = JSON.parse(rawBody).type;
        if (operation && CHATKIT_INFERENCE_OPERATIONS.includes(operation)) {
            await cancellable(this.#preparation.ensure(), cancellation);
            cancellation.throwIfAborted();
            latency = new BrowserLatencyProbe;
            this.#latencyProbe = latency;
            headers.set("x-ai-dm-trace", latency.traceId);
            if(this.#forestBudget) {
                const body=JSON.parse(rawBody);
                if(body.params?.thread_id!==this.#forestBudget.threadId||!['threads.create','threads.add_user_message'].includes(operation)||Date.parse(this.#forestBudget.expiresAt)<=Date.now())throw Error('Forest budget scope changed or expired. No model request was sent.');
                headers.set('x-ai-dm-trace',this.#forestBudget.traceId);
            }
        }
        if (!supportedChatKitOperation(operation))
            throw new Error("Unsupported ChatKit operation.");
        if (CHATKIT_INFERENCE_OPERATIONS.includes(operation) && !headers.has("x-ai-dm-event")) {
            const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
            cancellation.throwIfAborted();
            if (this.#closed || (game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId)
                throw new Error("Chat request cancelled or owner changed.");
            pendingKey = `${pointerKey()}.pending.${Array.from(new Uint8Array(hash), (byte: any) => byte.toString(16).padStart(2, "0")).join("")}`;
            const eventId = localStorage.getItem(pendingKey) ?? crypto.randomUUID();
            localStorage.setItem(pendingKey, eventId);
            headers.set("x-ai-dm-event", eventId);
        }
    } if (destination.pathname === "/chatkit/actions" && rawBody) {
        latency = new BrowserLatencyProbe;
        headers.set("x-ai-dm-trace", latency.traceId);
    } const abort = new AbortController; this.#requests.add(abort); const signal = AbortSignal.any([abort.signal, cancellation, ...init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []]); try {
        signal.throwIfAborted();
        const response = await fetch(input, { ...init, headers, signal });
        latency?.mark("browser-response-headers");
        if (!response.ok) {
            this.#requests.delete(abort);
            throw new Error(response.status === 401 ? "Foundry authentication expired. Reconnect and try again." : response.status === 403 ? "ChatKit currently requires an authenticated GM." : response.status === 409 ? "A response is already running." : response.status === 503 ? "ChatKit server or OpenAI authorization is not configured." : "ChatKit server request failed.");
        }
        if (!response.body) {
            this.#requests.delete(abort);
            if (pendingKey)
                localStorage.removeItem(pendingKey);
            return response;
        }
        const reader = response.body.getReader();
        const requests = this.#requests;
        const body = new ReadableStream({ async pull(controller: any) { try {
                const item = await reader.read();
                if (item.done) {
                    latency?.finish();
                    latency?.mark("browser-stream-end");
                    requests.delete(abort);
                    if (pendingKey)
                        localStorage.removeItem(pendingKey);
                    controller.close();
                }
                else {
                    latency?.chunk(item.value);
                    controller.enqueue(item.value);
                }
            }
            catch (error) {
                requests.delete(abort);
                latency?.mark("browser-stream-error");
                controller.error(error);
            } }, async cancel(reason: any) { latency?.mark("browser-stream-cancelled"); abort.abort(); requests.delete(abort); await reader.cancel(reason); } });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    catch (error) {
        this.#requests.delete(abort);
        this.fail(error);
        throw error;
    } }, "authenticatedFetch");
    async reviewNativeActions() { if (!this.#threadId) {
        this.status("Open a conversation before reviewing actions.");
        return;
    } const panel = this.element.querySelector<PanelElement>(".ai-dm-native-actions"); if (!panel)
        return; const threadId = this.#threadId; const epoch = this.#reviewEpoch; const response = await this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) }); const data = await response.json(); if (this.#closed || epoch !== this.#reviewEpoch || this.#threadId !== threadId)
        return; panel.replaceChildren(); for (const action of data.result) {
        if (action.kind === "world" || action.kind === "world-file")
            continue;
        if (action.status === "pending") this.showReviewDrawer();
        const row = document.createElement("section");
        const label = document.createElement("p");
        const title = action.kind === "pause" ? action.input?.paused ? "Pause game" : "Unpause game" : action.kind === "session" ? action.input?.action?.kind ?? "Game action" : action.kind === "note" ? action.input?.title : action.input?.formula;
        label.textContent = `${title ?? "Game action"}: ${action.status}${action.receipt?.total !== void 0 ? `, total ${action.receipt.total}` : ""}`;
        row.append(label);
        if (action.kind === "note") {
            const preview = document.createElement("p");
            preview.textContent = action.input?.text ?? "";
            row.append(preview);
            if (action.status === "pending")
                for (const choice of ["approve", "reject"]) {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.textContent = choice === "approve" ? "Approve private session journal" : "Reject";
                    button.addEventListener("click", () => { if (this.#closed || epoch !== this.#reviewEpoch || this.#threadId !== threadId)
                        return; button.disabled = true; void this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, actionId: action.actionId, decision: choice }) }).then(async (response2: any) => { await response2.json(); await this.reviewNativeActions(); }).catch((error: any) => { this.fail(error); button.disabled = false; }); });
                    row.append(button);
                }
        }
        panel.append(row);
    } if (!data.result.length)
        panel.textContent = "No native actions in this conversation."; }
    invalidateReviews() { const drawer = this.element?.querySelector<HTMLDetailsElement>(".ai-dm-review-drawer"); if (drawer?.tagName === "DETAILS") { drawer.hidden = true; drawer.open = false; } this.#reviewEpoch++; this.#worldLoadGeneration.world++; this.#worldLoadGeneration["world-file"]++; this.#campaignLoadGeneration++; this.#campaignListeners?.abort(); for (const selector of [".ai-dm-native-actions", ".ai-dm-attack-actions", ".ai-dm-campaign-actions", ".ai-dm-world-actions", ".ai-dm-world-file-actions"]) {
        const panel = this.element?.querySelector<PanelElement>(selector);
        if (panel && typeof panel.replaceChildren === "function") {
            panel.replaceChildren();
            panel.textContent = "Review cleared. Use Review proposed actions to refresh.";
        }
    } }
    async openCampaignSetup() {
        if (!game.user.isGM || game.user.id !== this.#userId || game.world?.id !== this.#worldId || this.#closed) throw new Error('Current GM required');
        const host = this.element.querySelector<HTMLElement>('.ai-dm-campaign-setup'); if (!host) return;
        this.#campaignPreparationPanel?.cancel();
        this.#campaignPreparationPanel = new CampaignPreparationPanel(host, async (input, signal) => {
            if (!game.user.isGM || game.user.id !== this.#userId || game.world?.id !== this.#worldId || this.#closed) throw new Error('Campaign setup scope changed');
            const auth = aiDmController.transport.chatKitHeaders?.(); if (!auth) throw new Error('Reconnect required');
            const response = await fetch(`${gatewayUrl()}/preparation`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'interview', input }), signal });
            if (!response.ok) throw new Error('Campaign setup unavailable');
            const body = await response.json();
            if (this.#closed || game.world?.id !== this.#worldId || game.user.id !== this.#userId || body.worldId !== this.#worldId) throw new Error('Campaign setup scope changed');
            return body.result;
        });
        await this.#campaignPreparationPanel.open();
    }
    async openForestMap() {
        if(!game.user.isGM||game.user.id!==this.#userId||game.world?.id!==this.#worldId||this.#worldId!=='mcp-test'||this.#closed)throw Error('Test GM required');
        const host=this.element.querySelector<HTMLElement>('.ai-dm-forest-map');if(!host)return;
        this.#forestBattlemapPanel?.cancel();
        this.#forestBattlemapPanel=new ForestBattlemapPanel(host,async(operation,input,signal)=>{
            if(this.#closed||game.world?.id!==this.#worldId||game.user.id!==this.#userId||!game.user.isGM)throw Error('Forest scope changed');
            const auth=aiDmController.transport.chatKitHeaders?.();if(!auth)throw Error('Reconnect required');
            if(operation==='battlemap-thread') {
                if(this.#guard.busy||this.#responseActive||this.#queuedTriggers)throw Error('Wait for the current response to finish.');
                const response=await this.authenticatedFetch(`${gatewayUrl()}/thread`,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal});
                const body=await response.json();if(typeof body.threadId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.threadId))throw Error('Thread bootstrap failed.');
                if(this.#closed||game.world?.id!==this.#worldId||game.user.id!==this.#userId)throw Error('Forest scope changed');
                this.#threadId=body.threadId;this.#forestBudget=null;localStorage.setItem(pointerKey(),body.threadId);await this.#component?.setThreadId(body.threadId);
                return {status:'thread-ready',threadId:body.threadId,worldId:this.#worldId,userId:this.#userId,providerRequests:0};
            }
            if(operation==='battlemap-acceptance'||operation.startsWith('battlemap-generation-')||input['generationId']!==undefined)input={...input,threadId:this.#threadId};
            const response=await fetch(`${gatewayUrl()}/preparation`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({operation,input}),signal});
            const body=await response.json();
            const hints:Record<string,string>={FOREST_APPROVED_IMPORT_REQUIRED:'Import the approved forest artwork first.',FOREST_TV_FULLSCREEN_REQUIRED:'Put the actual TV browser in fullscreen (F11), then prepare and review again. Measure a grid square after display.',FOREST_DIGITAL_TABLETOP_955_MM_REQUIRED:'Enable Digital Tabletop and confirm its physical display width is 955 mm before preparing TV output.',FOREST_EXACT_TV_REQUIRED:'Connect and enroll the exact TV client, or select GM preview.',FOREST_FRESH_DISPLAY_REQUIRED:'Deploy the companion display update and reconnect this client.',FOREST_DISPLAY_CHANGED_REPREPARE_REQUIRED:'The client or viewport changed. Prepare and review again.',FOREST_VIEW_NAMED_SCENE_FIRST:'View the named forest fixture in Scenes before fitting it.',FOREST_PRELOAD_NOT_READY:'The approved forest artwork did not finish loading.',FOREST_SCENE_CHANGED:'The fixture changed. Check its native receipt before further actions.'};
            if(!response.ok)throw Error(hints[String(body.reasonCode)]??(/^[A-Z_]{3,80}$/.test(String(body.reasonCode??body.code))?`Forest workflow unavailable (${body.reasonCode??body.code}). Reconnect and inspect the receipt.`:'Forest workflow unavailable. Reconnect and inspect the receipt.'));
            if(this.#closed||game.world?.id!==this.#worldId||game.user.id!==this.#userId||body.worldId!==this.#worldId)throw Error('Forest scope changed');
            if(operation==='battlemap-acceptance') {
                const binding=body.result;
                if(binding.threadId!==this.#threadId||binding.worldId!==this.#worldId||binding.userId!==this.#userId||!Number.isInteger(binding.maxModelRequests)||binding.maxModelRequests<1||binding.maxModelRequests>6||!binding.fixtureId?.startsWith('forest-')||Date.parse(binding.expiresAt)<=Date.now())throw Error('Forest budget binding changed.');
                this.#forestBudget={threadId:binding.threadId,traceId:binding.traceId,expiresAt:binding.expiresAt};
            }
            return body.result;
        });
        this.#forestBattlemapPanel.open();
    }
    checkPendingReviews() { const drawer = this.element?.querySelector<HTMLDetailsElement>(".ai-dm-review-drawer"); if (drawer?.tagName !== "DETAILS" || !this.#threadId || this.#closed) return; const epoch = this.#reviewEpoch, threadId = this.#threadId; void this.reviewActionsAfterResponse().catch(() => { if (!this.#closed && epoch === this.#reviewEpoch && threadId === this.#threadId) this.status("Action review unavailable. Open Account/settings to inspect actions and receipts before retrying a change."); }); }
    reviewActionsAfterResponse(): Promise<void> { const key = JSON.stringify([this.#threadId, this.#reviewEpoch]); if (this.#reviewBatch?.key === key) return this.#reviewBatch.promise; const promise = Promise.all([this.reviewNativeActions(), this.reviewAttackActions(), this.reviewCampaignActions(), this.reviewWorldActions("world"), this.reviewWorldActions("world-file")]).then(() => void 0); const batch = { key, promise }; this.#reviewBatch = batch; void promise.finally(() => { if (this.#reviewBatch === batch) this.#reviewBatch = null; }).catch(() => void 0); return promise; }
    async reviewActions() { this.showReviewDrawer(); await this.reviewActionsAfterResponse(); }
    async reviewAttackActions() { const selectedThread = this.#threadId; const threadId = selectedThread ?? "direct-control"; const panel = this.element?.querySelector<PanelElement>(".ai-dm-attack-actions"); if (!threadId || !panel)
        return; const epoch = this.#reviewEpoch, worldId = this.#worldId, userId = this.#userId; const current = __name(() => !this.#closed && epoch === this.#reviewEpoch && this.#threadId === selectedThread && (game.world?.id ?? "none") === worldId && game.user.id === userId, "current"); const response = await this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "attack", threadId }) }); const data = await response.json(); if (!current())
        return; if (!Array.isArray(data.result))
        throw new Error("Attack review unavailable."); panel.replaceChildren(); for (const raw of data.result.slice(0, 12)) {
        if (!raw || typeof raw !== "object")
            throw new Error("Invalid attack review.");
        const entry = raw;
        if (entry.scope?.worldId !== worldId || entry.scope.userId !== userId || entry.scope.threadId !== threadId || typeof entry.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.requestId))
            throw new Error("Attack review scope mismatch.");
        const row = document.createElement("section"), label = document.createElement("p"), state = entry.result?.state;
        label.textContent = `Attack: ${String(entry.result?.outcome ?? "uncertain")} (${String(state?.stage ?? "unconfirmed")}); damage rolled ${String(state?.damageRolled ?? "unknown")}, applied ${String(state?.damageApplied ?? "not applied")}.`;
        row.append(label);
        if (entry.result?.outcome === "decision-required") this.showReviewDrawer();
        if (entry.result?.outcome === "decision-required" && typeof state?.attackRequestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(state.attackRequestId) && Array.isArray(state?.decisions)) {
            for (const rawDecision of state.decisions.slice(0, 8)) {
                const decision = rawDecision;
                if (!decision || typeof decision.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(decision.id) || typeof decision.message !== "string")
                    throw new Error("Invalid attack decision ticket.");
                const message = document.createElement("p"), button = document.createElement("button");
                message.textContent = decision.message.slice(0, 1000);
                button.type = "button";
                button.textContent = "Player decisions resolved; apply recorded damage";
                const actionId = crypto.randomUUID(), priorAttackRequestId = state.attackRequestId, decisionId = decision.id;
                button.addEventListener("click", () => { if (!current())
                    return; button.disabled = true; void this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "attack", threadId, actionId, action: { mode: "apply", priorAttackRequestId, decisionId } }) }).then(async (result: any) => { const outcome = await result.json(); if (current()) {
                    label.textContent = `Damage application: ${String(outcome.result?.outcome ?? "uncertain")}.`;
                    await this.reviewAttackActions();
                } }).catch((error: any) => { this.fail(error); button.disabled = false; }); });
                row.append(message);
                if (decision.kind === "reaction")
                    row.append(button);
            }
        }
        panel.append(row);
    } if (!data.result.length)
        panel.textContent = "No attack receipts in this conversation."; }
    async reviewWorldActions(kind: "world" | "world-file", actionId?: string) { const threadId = this.#threadId; if (!threadId)
        return; const panel = this.element.querySelector<PanelElement>(kind === "world" ? ".ai-dm-world-actions" : ".ai-dm-world-file-actions"); if (!panel)
        return; const epoch = this.#reviewEpoch; const generation = ++this.#worldLoadGeneration[kind]; const current = __name(() => !this.#closed && epoch === this.#reviewEpoch && threadId === this.#threadId && generation === this.#worldLoadGeneration[kind] && (game.world?.id ?? "none") === this.#worldId && game.user.id === this.#userId, "current"); const result = await this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, threadId, ...actionId ? { actionId } : {} }) }); const data = await result.json(); if (!current())
        return; panel.replaceChildren(); if (!actionId) {
        if (!Array.isArray(data.result))
            throw new Error("World proposal list unavailable.");
        for (const item of data.result.slice(0, 12)) {
            const summary = item;
            if (summary.status === "pending") this.showReviewDrawer();
            if (summary.kind !== kind || typeof summary.status !== "string" || typeof summary.actionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(summary.actionId))
                throw new Error("Invalid world proposal summary.");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = `Review world change: ${summary.status}`;
            button.addEventListener("click", () => { if (current())
                void this.reviewWorldActions(kind, summary.actionId).catch((error: any) => this.fail(error)); });
            panel.append(button);
        }
        return;
    } const review = await validateWorldReview(data.result, { worldId: this.#worldId, userId: this.#userId, threadId }); if (!current())
        return; const state = document.createElement("p"); state.textContent = `World change: ${review.status}`; panel.append(state); if (review.receipt) {
        const receipt = document.createElement("pre");
        receipt.textContent = JSON.stringify(review.receipt, null, 2);
        panel.append(receipt);
    } for (const [label, value] of [["Current state", review.before], ["Exact requested change", review.request]] as const) {
        const heading = document.createElement("h3");
        heading.textContent = label;
        const text = document.createElement("pre");
        text.textContent = JSON.stringify(value, null, 2);
        panel.append(heading, text);
    } if (review.status !== "pending")
        return; const buttons: HTMLButtonElement[] = []; for (const decision of ["approve", "reject", "cancel"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = decision === "approve" ? "Approve this exact world change" : decision === "reject" ? "Reject change" : "Cancel proposal";
        button.addEventListener("click", () => { if (!current() || button.disabled)
            return; buttons.forEach((control: any) => { control.disabled = true; }); void this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, threadId, actionId, reviewDigest: review.reviewDigest, decision }) }).then(async (response: any) => { await response.json(); if (current())
            await this.reviewWorldActions(kind, actionId); }).catch(() => { if (current())
            state.textContent = "Outcome requires inspection. Refresh this review before deciding again."; }); });
        buttons.push(button);
        panel.append(button);
    } }
    async reviewCampaignActions(proposalId?: string) { const threadId = this.#threadId; if (!threadId) {
        this.status("Open a conversation before reviewing campaign changes.");
        return;
    } const panel = this.element.querySelector<PanelElement>(".ai-dm-campaign-actions"); if (!panel)
        return; const epoch = this.#reviewEpoch; const generation = ++this.#campaignLoadGeneration; this.#campaignListeners?.abort(); this.#campaignListeners = new AbortController; const listeners = this.#campaignListeners.signal; const current = __name(() => !this.#closed && epoch === this.#reviewEpoch && generation === this.#campaignLoadGeneration && threadId === this.#threadId && (game.world?.id ?? "none") === this.#worldId && game.user.id === this.#userId, "current"); panel.replaceChildren(); panel.textContent = "Loading campaign review\u2026"; const response = await this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "campaign", threadId, ...proposalId ? { proposalId } : {} }) }); const data = await response.json(); if (!current())
        return; panel.replaceChildren(); panel.textContent = ""; if (!proposalId) {
        if (!Array.isArray(data.result))
            throw new Error("Campaign proposal list unavailable.");
        for (const value of data.result.slice(0, 12)) {
            const summary = value;
            if (summary.status === "pending") this.showReviewDrawer();
            if (summary.kind !== "campaign" || typeof summary.proposalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(summary.proposalId) || typeof summary.title !== "string" || typeof summary.status !== "string")
                throw new Error("Invalid campaign proposal summary.");
            const row = document.createElement("section");
            const label = document.createElement("p");
            label.textContent = `${summary.title}: ${summary.status}. Open the complete changes before deciding.`;
            row.append(label);
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "View exact campaign changes";
            const selected = summary.proposalId;
            button.addEventListener("click", () => { if (current())
                void this.reviewCampaignActions(selected).catch((error: any) => this.fail(error)); }, { signal: listeners });
            row.append(button);
            panel.append(row);
        }
        if (!data.result.length)
            panel.textContent = "No campaign proposals in this conversation. Ask your dungeon master to create a campaign or prepare a change.";
        return;
    } let review; try {
        review = await validateCampaignReview(data.result, { worldId: this.#worldId, userId: this.#userId, threadId });
    }
    catch (error) {
        if (current()) {
            panel.textContent = error instanceof Error ? error.message : "Exact campaign review unavailable.";
        }
        return;
    } if (!current())
        return; const heading = document.createElement("h3"); heading.textContent = review.title; panel.append(heading); const state = document.createElement("p"); state.textContent = campaignReceiptText(review); panel.append(state); if (review.issue) {
        const issue = document.createElement("p");
        issue.textContent = review.issue;
        panel.append(issue);
    } const digest = document.createElement("p"); digest.textContent = `Review digest: ${review.batchDigest}`; digest.className = "ai-dm-review-revision"; panel.append(digest); for (const file of review.files) {
        const row = document.createElement("details");
        row.open = true;
        const label = document.createElement("summary");
        label.textContent = `${file.path}: ${file.beforeCanonStatus ?? "new draft"} \u2192 ${file.afterCanonStatus}`;
        row.append(label);
        for (const [labelText, content] of [[`Before \u2014 revision ${file.expectedRevision ?? "absent"}`, file.beforeText ?? "[New file: no previous content]"], [`Proposed \u2014 SHA-256 ${file.afterHash}`, file.proposedText]] as const) {
            const label2 = document.createElement("p");
            label2.textContent = labelText;
            const text = document.createElement("pre");
            text.textContent = content;
            row.append(label2, text);
        }
        panel.append(row);
    } if (review.status !== "pending")
        return; const buttons: HTMLButtonElement[] = []; for (const choice of ["approve", "reject", "cancel"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = choice === "approve" ? "Approve these exact campaign changes" : choice === "reject" ? "Reject campaign changes" : "Cancel campaign proposal";
        button.disabled = choice === "approve" && Date.now() >= review.expiresAt;
        button.addEventListener("click", () => { if (!current() || button.disabled)
            return; if (choice === "approve" && Date.now() >= review.expiresAt) {
            button.disabled = true;
            state.textContent = "This review expired. Ask for a refreshed campaign proposal.";
            return;
        } for (const control of buttons)
            control.disabled = true; void this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "campaign", threadId, proposalId: review.proposalId, batchDigest: review.batchDigest, decision: choice }) }).then(async (response2: any) => { await response2.json(); if (current())
            await this.reviewCampaignActions(review.proposalId); }).catch((error: any) => { if (current()) {
            this.fail(error);
            state.textContent = "Decision outcome requires inspection. Refresh the exact review before deciding again.";
        } }); }, { signal: listeners });
        buttons.push(button);
        panel.append(button);
    } }
    trigger(request: ChatKitTrigger, externalSignal?: AbortSignal) { this.#queuedTriggers++; this.updateStopControl(); const generation = this.#triggerGeneration; const signal = AbortSignal.any([this.#triggerCancellation.signal, ...externalSignal ? [externalSignal] : []]); const pending = this.#triggerTail.then(() => { if (generation !== this.#triggerGeneration || this.#closed)
        throw new Error("Queued response cancelled."); signal.throwIfAborted(); return this.dispatchTrigger(request, generation, signal); }); this.#triggerTail = pending.catch(() => { }); return cancellable(pending, signal).finally(() => { this.#queuedTriggers = Math.max(0, this.#queuedTriggers - 1); this.updateStopControl(); }); }
    async directControl(command: string) { if (!game.user.isGM || game.world?.id !== this.#worldId || game.user.id !== this.#userId)
        throw new Error("Current GM world required. Reopen the dungeon master panel."); const action = parseCoreCommand(command); const requestId = crypto.randomUUID(); const response = await this.authenticatedFetch(`${gatewayUrl()}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: action["mode"] === "roll" || action["mode"] === "apply" ? "attack" : "core", threadId: this.#threadId ?? "direct-control", actionId: requestId, action }) }); if (!response.ok)
        throw new Error("Control request failed. Inspect current state before a new request."); const data = await response.json(); console.info(JSON.stringify({ type: "core-direct-result", requestId, ...data.result })); if (data.result?.outcome === "confirmed")
        ui.notifications.info("Game action confirmed.");
    else
        ui.notifications.warn(`Game action ${data.result?.outcome ?? "uncertain"}. Inspect state before a new request.`); }
    async dispatchTrigger(request: ChatKitTrigger, generation: number, signal: AbortSignal) { const check = __name(() => { signal.throwIfAborted(); if (this.#closed || generation !== this.#triggerGeneration)
        throw new Error("Response cancelled."); if ((game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId)
        throw new Error("World or player changed. Reopen the dungeon master panel."); }, "check"); check(); if (!game.user.isGM)
        throw new Error("ChatKit currently requires a Foundry GM."); const prompt = request.prompt?.trim(); if (!prompt || prompt.length > 4000)
        throw new Error("Enter a prompt of 1\u20134000 characters."); const context = boundedContext(request.context ?? currentGameContext()); const requestId = request.requestId ?? crypto.randomUUID(); await this.waitForIdle(signal); check(); if (!this.#guard.start(requestId))
        return; this.#requestFailed = false; this.status("Preparing game-context response\u2026"); try {
        if (!this.#component) {
            await cancellable(this.render({ force: true }), signal);
            check();
        }
        await cancellable(this.#mounting, signal);
        check();
        const component = this.#component;
        await cancellable(this.#ready, signal);
        check();
        if (this.#component !== component)
            throw new Error("Chat panel changed before dispatch.");
        if (!this.#component)
            throw new Error("ChatKit is not ready.");
        const originalThread = this.#threadId;
        const checkThread = __name(() => { check(); if (this.#component !== component || this.#threadId !== originalThread)
            throw new Error("Conversation changed before dispatch."); }, "checkThread");
        if (!this.#threadId) {
            checkThread();
            const response = await cancellable(this.authenticatedFetch(`${gatewayUrl()}/thread`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal }), signal);
            checkThread();
            const data = await cancellable(response.json(), signal);
            checkThread();
            if (typeof data.threadId !== "string")
                throw new Error("Could not initialize the ChatKit conversation.");
            this.#threadId = data.threadId;
            localStorage.setItem(pointerKey(), data.threadId);
            const selection = { id: data.threadId, generation };
            this.#threadSelection = selection;
            const selected = this.#component.setThreadId(data.threadId).finally(() => { if (this.#threadSelection === selection)
                this.#threadSelection = null; });
            await cancellable(selected, signal);
            check();
            if (this.#component !== component || this.#threadId !== data.threadId)
                throw new Error("Conversation changed before dispatch.");
        }
        else {
            checkThread();
        }
        check();
        this.#dispatchCancellation = signal;
        const sending = this.#component.sendCustomAction({ type: "foundry.context-response", payload: { requestId, prompt, context, ...request.automatic ? { automatic: request.automatic } : {} } }).finally(() => { if (this.#dispatchCancellation === signal)
            this.#dispatchCancellation = null; });
        await cancellable(sending, signal);
        check();
    }
    catch (error) {
        if (!this.#closed && generation === this.#triggerGeneration)
            this.fail(error);
        throw error;
    }
    finally {
        this.finishGuard();
    } }
    cancel() { this.#responseActive = false; this.#preparation.invalidate("Preparation cancelled. Submit or refresh status to check again."); this.#preparationKey = ""; cancelAutomaticEventLifecycle(); this.invalidateReviews(); this.#triggerGeneration++; this.#triggerCancellation.abort(new Error("Response cancelled.")); this.#triggerCancellation = new AbortController; for (const request of this.#requests)
        request.abort(); this.#requests.clear(); this.finishGuard(); this.status("Response stopped locally. Confirmed changes remain; server or provider work may have completed. Review actions and receipts before retrying."); }
    override async close(options: any = {}) { aiDmController.closeStatusPanel(); this.#campaignPreparationPanel?.cancel(); this.#forestBattlemapPanel?.cancel(); this.#closed = true; this.#preparation.invalidate("Panel closed."); this.#playerObservationPanel?.cancel(); this.#playerObservationPanel = null; this.#mountGeneration++; this.#unsubscribe?.(); this.#unsubscribe = null; this.#providerListeners?.abort(); this.cancel(); this.#listeners?.abort(); this.#component?.remove(); this.#component = null; this.#mounting = null; AiDungeonMasterApplication.#instance = null; await super.close(options); }
}
export { AiDungeonMasterApplication };
