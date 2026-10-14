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
import { chatGptPanelStatus } from "./chatgpt-panel.js";
import { chatKitDomainKey } from "./chatkit-domain.js";
import { validateCampaignReview, campaignReceiptText } from "./campaign-review.js";
import { validateWorldReview } from "./world-review.js";
import { cancelAutomaticEventLifecycle } from "./automatic-triggers.js";
import { BrowserLatencyProbe, latencyDownloadButton } from "./latency-probe.js";
import { parseCoreCommand } from "./core-command.js";
import type { ChatKitTrigger } from "./chatkit-context.js";
import { boundedContext, currentGameContext, TriggerGuard } from "./chatkit-context.js";
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
    static DEFAULT_OPTIONS = { id: MODULE_ID, classes: [MODULE_ID], tag: "div", position: { width: 620, height: 720 }, window: { title: "AI Dungeon Master", resizable: true, minimizable: true }, actions: { contextResponse: __name(() => { void this.#instance?.trigger({ prompt: "Describe the current game situation using the supplied context.", context: currentGameContext() }).catch((error: any) => this.#instance?.fail(error)); }, "contextResponse"), resolveAction: __name(() => { void this.#instance?.trigger({ prompt: "Resolve the selected player action using current authorized state. If the player's intent is unclear, ask for it. Use only permitted native tools; request confirmation for persistent session notes and never claim an unexecuted action." }).catch((error: any) => this.#instance?.fail(error)); }, "resolveAction"), cancelResponse: __name(() => this.#instance?.cancel(), "cancelResponse"), reviewNativeActions: __name(() => { void this.#instance?.reviewActions().catch((error: any) => this.#instance?.fail(error)); }, "reviewNativeActions"), chatGptSignIn: __name(() => this.#instance?.providerAction(() => aiDmController.beginChatGptSignIn()), "chatGptSignIn"), chatGptRefresh: __name(() => this.#instance?.providerAction(() => aiDmController.refreshChatGptStatus()), "chatGptRefresh"), chatGptSignOut: __name(() => this.#instance?.providerAction(() => aiDmController.signOutChatGpt()), "chatGptSignOut") } };
    static PARTS = { main: { template: `modules/${MODULE_ID}/module/templates/ai-dungeon-master/application.hbs` } };
    static #instance: AiDungeonMasterApplication | null = null;
    #component: ChatKitElement | null = null;
    #latencyProbe: BrowserLatencyProbe | null = null;
    #mounting: Promise<void> | null = null;
    #mountGeneration = 0;
    #ready: Promise<void> | null = null;
    #listeners: AbortController | null = null;
    #requests = new Set<AbortController>;
    #guard = new TriggerGuard;
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
    #status = "Connecting to ChatKit\u2026";
    #requestFailed = false;
    #unsubscribe: (() => void) | null = null;
    #providerListeners: AbortController | null = null;
    #reviewEpoch = 0;
    #campaignLoadGeneration = 0;
    #worldLoadGeneration = { world: 0, "world-file": 0 };
    #campaignListeners: AbortController | null = null;
    #worldId = game.world?.id ?? "none";
    #userId = game.user.id;
    constructor(options: any = {}) { super(options); this.#unsubscribe = aiDmController.store.subscribe(() => { if (!this.#closed)
        this.updateProviderControls(); }); }
    static open() { const instance = this.#instance ?? new this; this.#instance = instance; if (!instance.#component)
        instance.render({ force: true }); return instance; }
    static cancelOpen() { this.#instance?.cancel(); }
    finishGuard() { this.#guard.finish(); for (const wake of this.#idleWaiters)
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
    _prepareContext() { return { isGm: game.user.isGM, status: game.user.isGM ? this.#status : "ChatKit currently requires a Foundry GM.", providerStatus: chatGptPanelStatus(aiDmController.store.state) }; }
    _onRender() { if (!game.user.isGM)
        return; this.#providerListeners?.abort(); this.#providerListeners = new AbortController; const select = this.element.querySelector<PanelElement>("[data-chatgpt-model]"); if (select?.tagName === "SELECT")
        select.addEventListener("change", () => { this.providerAction(() => aiDmController.selectChatGptModel(select.value)); }, { signal: this.#providerListeners.signal }); this.updateProviderControls(); const mount = this.element.querySelector<PanelElement>(".ai-dm-chatkit-mount"); if (!mount)
        return; if (this.#component) {
        mount.append(this.#component);
        if (!mount.parentElement?.querySelector<PanelElement>(".ai-dm-latency-export"))
            mount.parentElement?.append(latencyDownloadButton());
        return;
    } this.#mounting ??= this.mount(mount).catch((error: any) => { this.fail(error); throw error; }); void this.#mounting.catch(() => void 0); }
    status(text: string) { this.#status = text; const node = this.element?.querySelector<PanelElement>(".ai-dm-chatkit-status"); if (node)
        node.textContent = text; }
    providerAction(action: any) { if (!game.user.isGM || !action()) {
        const node = this.element?.querySelector<PanelElement>(".ai-dm-provider-status");
        if (node)
            node.textContent = "Connect as a Foundry GM before changing ChatGPT authorization. Allow popups for sign-in, then try again.";
    } }
    updateProviderControls() { if (!game.user.isGM)
        return; const state = aiDmController.store.state; const status = this.element?.querySelector<PanelElement>(".ai-dm-provider-status"); if (status)
        status.textContent = chatGptPanelStatus(state); const connected = state.connection === "connected" && state.authenticatedLane === "gm"; for (const action of ["chatGptSignIn", "chatGptRefresh", "chatGptSignOut"]) {
        const button = this.element?.querySelector<PanelElement>(`[data-action="${action}"]`);
        if (button?.tagName === "BUTTON")
            button.disabled = !connected || action === "chatGptSignOut" && !state.chatGpt.identityConnected;
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
    fail(error: unknown) { this.#requestFailed = true; this.finishGuard(); this.status(error instanceof Error ? error.message : "ChatKit request failed."); }
    async mount(mount: HTMLElement) { const generation = ++this.#mountGeneration; await loadRuntime(); if (this.#closed || generation !== this.#mountGeneration || (game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId)
        return; const domainValue = game.settings.get(MODULE_ID, "chatKitDomainKey"); const domainKey = chatKitDomainKey(domainValue, globalThis.location?.hostname ?? ""); if (!domainKey)
        throw new Error("Set the ChatKit domain key in module settings for this Foundry browser origin."); const threadPointer = `${MODULE_ID}.chatkit.thread.${this.#worldId}.${this.#userId}`; this.#threadId = localStorage.getItem(threadPointer); const component = document.createElement("openai-chatkit") as ChatKitElement; this.#listeners = new AbortController; const options = { signal: this.#listeners.signal }; this.#ready = new Promise<void>((resolve: any, reject: any) => { const timeout = window.setTimeout(() => reject(new Error("ChatKit did not become ready. Check the registered domain key and CDN access.")), 20000); component.addEventListener("chatkit.ready", () => { window.clearTimeout(timeout); resolve(); }, { ...options, once: true }); this.#listeners?.signal.addEventListener("abort", () => { window.clearTimeout(timeout); reject(new Error("Chat panel closed.")); }, { once: true }); }); void this.#ready.catch((error: any) => { if (!this.#closed)
        this.fail(error); }); component.addEventListener("chatkit.thread.change", (event: any) => { if (this.#closed || generation !== this.#mountGeneration || this.#component !== component || (game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId)
        return; if (this.#threadSelection?.id === event.detail.threadId && this.#threadSelection!.generation !== this.#triggerGeneration)
        return; this.invalidateReviews(); this.#threadId = event.detail.threadId; if (this.#threadId)
        localStorage.setItem(threadPointer, this.#threadId);
    else
        localStorage.removeItem(threadPointer); }, options); component.addEventListener("chatkit.response.start", () => { this.#requestFailed = false; this.#guard.busy = true; this.status("Receiving response\u2026"); }, options); component.addEventListener("chatkit.response.end", () => { this.#latencyProbe?.mark("browser-chatkit-response-end"); this.finishGuard(); if (!this.#requestFailed)
        this.status("Ready"); }, options); component.addEventListener("chatkit.error", () => this.fail(new Error("ChatKit could not complete the request. Check connection, Foundry authentication and server configuration.")), options); component.setOptions({ api: { url: gatewayUrl(), domainKey, fetch: this.authenticatedFetch }, initialThread: this.#threadId, frameTitle: "AI Dungeon Master chat", theme: "dark", composer: { attachments: { enabled: false } }, history: { enabled: true } }); this.#component = component; mount.append(component); if (!mount.parentElement?.querySelector<PanelElement>(".ai-dm-latency-export"))
        mount.parentElement?.append(latencyDownloadButton()); this.status("Ready. Every message is a conversation with your dungeon master."); }
    authenticatedFetch = __name(async (input: RequestInfo | URL, init?: RequestInit) => { const cancellation = AbortSignal.any([this.#triggerCancellation.signal, ...this.#dispatchCancellation ? [this.#dispatchCancellation] : []]); cancellation.throwIfAborted(); if (this.#closed)
        throw new Error("Chat panel is closed."); if ((game.world?.id ?? "none") !== this.#worldId || game.user.id !== this.#userId) {
        this.cancel();
        throw new Error("World or player changed. Reopen the dungeon master panel.");
    } const destination = new URL(input instanceof Request ? input.url : String(input), gatewayUrl()); const gateway = new URL(gatewayUrl()); if (destination.origin !== gateway.origin || !["/chatkit", "/chatkit/thread", "/chatkit/actions"].includes(destination.pathname)) {
        throw new Error("Refused to send Foundry authentication outside the ChatKit gateway.");
    } const headers = new Headers(input instanceof Request ? input.headers : void 0); new Headers(init?.headers).forEach((value: any, key: any) => headers.set(key, value)); headers.delete("chatkit-frame-instance-id"); const auth = aiDmController.transport.chatKitHeaders?.(); if (!auth)
        throw new Error("Foundry authentication is unavailable."); for (const [key, value] of Object.entries(auth))
        headers.set(key, value); let latency: BrowserLatencyProbe | undefined; let pendingKey: string | undefined; const rawBody = typeof init?.body === "string" ? init.body : void 0; if (destination.pathname === "/chatkit" && rawBody) {
        const operation = JSON.parse(rawBody).type;
        if (operation && CHATKIT_INFERENCE_OPERATIONS.includes(operation)) {
            latency = new BrowserLatencyProbe;
            this.#latencyProbe = latency;
            headers.set("x-ai-dm-trace", latency.traceId);
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
    invalidateReviews() { this.#reviewEpoch++; this.#worldLoadGeneration.world++; this.#worldLoadGeneration["world-file"]++; this.#campaignLoadGeneration++; this.#campaignListeners?.abort(); for (const selector of [".ai-dm-native-actions", ".ai-dm-attack-actions", ".ai-dm-campaign-actions", ".ai-dm-world-actions", ".ai-dm-world-file-actions"]) {
        const panel = this.element?.querySelector<PanelElement>(selector);
        if (panel && typeof panel.replaceChildren === "function") {
            panel.replaceChildren();
            panel.textContent = "Review cleared. Use Review proposed actions to refresh.";
        }
    } }
    async reviewActions() { await Promise.all([this.reviewNativeActions(), this.reviewAttackActions(), this.reviewCampaignActions(), this.reviewWorldActions("world"), this.reviewWorldActions("world-file")]); }
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
    trigger(request: ChatKitTrigger, externalSignal?: AbortSignal) { const generation = this.#triggerGeneration; const signal = AbortSignal.any([this.#triggerCancellation.signal, ...externalSignal ? [externalSignal] : []]); const pending = this.#triggerTail.then(() => { if (generation !== this.#triggerGeneration || this.#closed)
        throw new Error("Queued response cancelled."); signal.throwIfAborted(); return this.dispatchTrigger(request, generation, signal); }); this.#triggerTail = pending.catch(() => { }); return cancellable(pending, signal); }
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
    cancel() { cancelAutomaticEventLifecycle(); this.invalidateReviews(); this.#triggerGeneration++; this.#triggerCancellation.abort(new Error("Response cancelled.")); this.#triggerCancellation = new AbortController; for (const request of this.#requests)
        request.abort(); this.#requests.clear(); this.finishGuard(); this.status("Response cancelled."); }
    override async close(options: any = {}) { this.#closed = true; this.#mountGeneration++; this.#unsubscribe?.(); this.#unsubscribe = null; this.#providerListeners?.abort(); this.cancel(); this.#listeners?.abort(); this.#component?.remove(); this.#component = null; this.#mounting = null; AiDungeonMasterApplication.#instance = null; await super.close(options); }
}
export { AiDungeonMasterApplication };
