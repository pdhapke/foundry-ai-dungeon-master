import {
  AI_DM_PROTOCOL_VERSION,
  aiDmTransportServerMessageSchema,
  type AiDmClientMessage,
  type AiDmTransportServerMessage,
} from "@foundry-ai-dungeon-master/shared";

import { AiDmClientStore } from "./store.js";
import { StatusRefresh } from "./status-refresh.js";

const MODULE_ID = "foundry-ai-dungeon-master";
const RECIPIENT_CURSOR_KEY = `${MODULE_ID}.recipient-cursor.v1`;
const LEGACY_SESSION_KEY = `${MODULE_ID}.session.v1`;
const FOUNDRY_AUTH_EVENT = "foundry-ai-dungeon-master.authenticate";
const AUTH_ACK_TIMEOUT_MS = 5_000;
const SESSION_RENEWAL_MARGIN_MS = 30_000;

interface MemorySession {
  credential: string;
  expiresAt: string;
}

function httpOrigin(webSocketUrl: string): string | null {
  try {
    const url = new URL(webSocketUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else return null;
    return url.origin;
  } catch {
    return null;
  }
}

export class AiDmTransport {
  readonly #store: AiDmClientStore;
  readonly #clientId = globalThis.crypto.randomUUID();
  readonly #browserSessionId = globalThis.crypto.randomUUID();
  #session: MemorySession | null = null;
  #socket: WebSocket | null = null;
  #manualClose = false;
  #reconnectAttempt = 0;
  #reconnectTimer: number | null = null;
  #authAckTimer: number | null = null;
  #sessionRenewalTimer: number | null = null;
  #renewingSession = false;
  #chatGptPopup: Window | null = null;
  #chatGptStatusTimer: number | null = null;
  #statusRefresh: StatusRefresh;
  #statusReply: { requestId: string; resolve: () => void; reject: (error: Error) => void } | null = null;
  #suppressStatusRefresh = false;
  #retiredStatusRequests = new Set<string>();

  constructor(store: AiDmClientStore) {
    this.#store = store;
    this.#statusRefresh = new StatusRefresh(signal => this.#fetchStatus(signal),
      () => !this.#suppressStatusRefresh && this.#store.state.connection === "connected" && this.#store.state.authenticatedLane === "gm",
      { schedule: (callback, delay) => window.setTimeout(callback, delay) as unknown as ReturnType<typeof setTimeout>,
        unschedule: timer => window.clearTimeout(timer as unknown as number),
        onFailure: () => ui.notifications.warn("Provider status could not be checked. Open AI DM account settings and recheck connection.") });
    window.addEventListener("message", (event) => {
      if (
        !this.#chatGptPopup ||
        event.source !== this.#chatGptPopup ||
        typeof event.data !== "object" ||
        event.data === null ||
        (event.data as { type?: unknown }).type !== "ai-dm.chatgpt.auth-complete" ||
        !game.settings
      )
        return;
      const expectedOrigin = httpOrigin(String(game.settings.get(MODULE_ID, "serverUrl")));
      if (
        expectedOrigin !== null &&
        event.origin === expectedOrigin &&
        event.source === this.#chatGptPopup &&
        typeof event.data === "object" &&
        event.data !== null &&
        (event.data as { type?: unknown }).type === "ai-dm.chatgpt.auth-complete"
      ) {
        this.#stopChatGptStatusPolling();
        this.refreshChatGptStatus();
      }
    });
  }

  connect(): void {
    this.#manualClose = false;
    sessionStorage.removeItem(LEGACY_SESSION_KEY);
    const cursor = Number(sessionStorage.getItem(RECIPIENT_CURSOR_KEY) ?? "0");
    if (Number.isSafeInteger(cursor) && cursor >= 0) this.#store.resetRecipientSequence(cursor);
    if (this.#socket?.readyState === WebSocket.OPEN && (!this.#session || Date.parse(this.#session.expiresAt) <= Date.now()))
      this.#renewSession();
    else this.#open();
  }

  disconnect(): void {
    this.#statusRefresh.close();
    this.#manualClose = true;
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    if (this.#authAckTimer !== null) window.clearTimeout(this.#authAckTimer);
    this.#authAckTimer = null;
    this.#clearSessionRenewal();
    this.#renewingSession = false;
    this.#socket?.close(1000, "Client closed");
    this.#socket = null;
    this.#session = null;
    this.#stopChatGptStatusPolling();
    this.#chatGptPopup?.close();
    this.#chatGptPopup = null;
  }

  openStatusPanel(): void {
    void this.#statusRefresh.open().catch(() => undefined);
  }

  closeStatusPanel(): void {
    this.#statusRefresh.close();
    this.#stopChatGptStatusPolling();
  }

  refreshChatGptStatus(): boolean {
    if (this.#store.state.connection !== "connected" || this.#store.state.authenticatedLane !== "gm") return false;
    void this.#statusRefresh.invalidate().catch(() => undefined);
    void this.#statusRefresh.open().catch(() => undefined);
    return true;
  }

  /** Short-lived Foundry credential stays in memory and is used only for gateway requests. */
  chatKitHeaders(): Record<string, string> {
    if (this.#store.state.connection === "authentication-failed" && this.#store.state.connectionMessage.startsWith("Foundry credential renewal failed:"))
      throw new Error(this.#store.state.connectionMessage);
    if (this.#session && Date.parse(this.#session.expiresAt) <= Date.now()) {
      this.#renewSession();
      throw new Error(this.#renewingSession
        ? "Your Foundry credential expired. Renewing your Foundry identity; submit again after Connected. No action was sent."
        : "Your Foundry credential expired. Reconnect as a Foundry GM; no action was sent.");
    }
    if (this.#renewingSession)
      throw new Error("Renewing your Foundry identity. Submit again after Connected; no action was sent.");
    if (
      !this.#session ||
      Date.parse(this.#session.expiresAt) <= Date.now() ||
      this.#store.state.connection !== "connected" ||
      this.#store.state.authenticatedLane !== "gm"
    ) {
      throw new Error("Connect as a Foundry GM before using ChatKit.");
    }
    return {
      "x-ai-dm-session": this.#session.credential,
      "x-ai-dm-client": this.#clientId,
      "x-ai-dm-browser-session": this.#browserSessionId,
      "x-ai-dm-version": "0.1.0",
    };
  }

  beginChatGptSignIn(): boolean {
    if (
      this.#socket?.readyState !== WebSocket.OPEN ||
      this.#store.state.connection !== "connected" ||
      this.#store.state.authenticatedLane !== "gm"
    )
      return false;
    const popup = window.open(
      "about:blank",
      "ai-dm-chatgpt-signin",
      "popup=yes,width=520,height=720,resizable=yes,scrollbars=yes",
    );
    if (!popup) {
      ui.notifications.warn("Allow popups for Foundry to sign in with ChatGPT.");
      return false;
    }
    popup.document.title = "Connecting ChatGPT";
    popup.document.body.textContent = "Preparing secure ChatGPT sign-in…";
    this.#chatGptPopup = popup;
    const sent = this.send({
      type: "aiDm.chatgpt.signin.begin",
      payload: { requestId: crypto.randomUUID() },
    });
    if (!sent) {
      popup.close();
      this.#chatGptPopup = null;
    }
    return sent;
  }

  send(command: AiDmClientMessage): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN || this.#store.state.connection !== "connected")
      return false;
    if (
      this.#store.state.authenticatedLane === "gm" &&
      this.#store.state.chatGpt.state !== "ready" &&
      (command.type === "aiDm.prompt.submit" ||
        command.type === "aiDm.event.submit" ||
        command.type === "aiDm.run.retry" ||
        (command.type === "aiDm.player-request.decide" && command.payload.decision === "approve"))
    )
      return false;
    if (command.type === "aiDm.chatgpt.model.select" || command.type === "aiDm.chatgpt.signout" || command.type === "aiDm.chatgpt.signin.begin") {
      // An older discovery reply cannot overwrite the subsequent provider mutation.
      this.#statusRefresh.close();
    }
    this.#socket.send(JSON.stringify({ type: "aiDm.command", payload: command }));
    return true;
  }

  #open(): void {
    if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) return;
    const url = String(game.settings.get(MODULE_ID, "serverUrl"));
    this.#store.setConnection("connecting", "Connecting to AI Dungeon Master…");
    const socket = new WebSocket(url);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      if (this.#session && Date.parse(this.#session.expiresAt) > Date.now() + 5_000)
        this.#sendConnect();
      else this.#sendIdentityRequest();
    });
    socket.addEventListener("message", (event) => { if (this.#socket === socket) this.#onMessage(event.data); });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#statusRefresh.close();
      this.#stopChatGptStatusPolling();
      this.#clearSessionRenewal();
      if (this.#authAckTimer !== null) window.clearTimeout(this.#authAckTimer);
      this.#authAckTimer = null;
      if (this.#store.state.connection !== "authentication-failed") {
        this.#store.setConnection("disconnected", "AI Dungeon Master server is disconnected.");
      }
      this.#socket = null;
      if (!this.#manualClose) this.#scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  #sendIdentityRequest(): void {
    const worldId = game.world?.id;
    if (!worldId) {
      this.#store.setConnection(
        "authentication-failed",
        "Open a Foundry world before connecting to AI Dungeon Master.",
      );
      this.#socket?.close(4003, "Missing world identity");
      return;
    }
    this.#session = null;
    this.#store.setConnection("authenticating", "Verifying your Foundry identity…");
    this.#socket?.send(
      JSON.stringify({
        type: "aiDm.auth.identify",
        payload: {
          protocolVersion: AI_DM_PROTOCOL_VERSION,
          clientId: this.#clientId,
          browserSessionId: this.#browserSessionId,
          worldId,
          moduleVersion: "0.1.0",
        },
      }),
    );
  }

  #clearSessionRenewal(): void {
    if (this.#sessionRenewalTimer !== null) window.clearTimeout(this.#sessionRenewalTimer);
    this.#sessionRenewalTimer = null;
  }

  #scheduleSessionRenewal(): void {
    this.#clearSessionRenewal();
    if (!this.#session || this.#manualClose) return;
    const delay = Math.max(0, Date.parse(this.#session.expiresAt) - Date.now() - SESSION_RENEWAL_MARGIN_MS);
    this.#sessionRenewalTimer = window.setTimeout(() => {
      this.#sessionRenewalTimer = null;
      this.#renewSession();
    }, delay);
  }

  /** Fresh socket uses the existing live Foundry challenge/assertion protocol.
   * The server ignores auth.identify on an already-authenticated socket.
   * Never resend a prompt or effect after renewing a credential.
   */
  #renewSession(): void {
    if (this.#manualClose || this.#renewingSession || this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#clearSessionRenewal();
    this.#renewingSession = true;
    this.#session = null;
    const previous = this.#socket;
    this.#statusRefresh.close();
    this.#socket = null; // Fence old socket events before closing it.
    previous.close(1000, "Renew Foundry identity");
    this.#open();
    this.#store.setConnection("authenticating", "Renewing your Foundry identity…");
  }

  #sendConnect(): void {
    if (!this.#session) return;
    this.#socket?.send(
      JSON.stringify({
        type: "aiDm.connect",
        payload: {
          protocolVersion: AI_DM_PROTOCOL_VERSION,
          clientId: this.#clientId,
          browserSessionId: this.#browserSessionId,
          sessionCredential: this.#session.credential,
          moduleVersion: "0.1.0",
        },
      }),
    );
  }

  #onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let unknownMessage: unknown;
    try {
      unknownMessage = JSON.parse(raw);
    } catch {
      return;
    }
    const validation = aiDmTransportServerMessageSchema.safeParse(unknownMessage);
    if (!validation.success) return;
    const parsed = validation.data as AiDmTransportServerMessage;
    if (parsed.type === "aiDm.auth.challenge") {
      this.#authenticateWithFoundry(parsed.payload);
      return;
    }
    if (parsed.type === "aiDm.auth.accepted") {
      this.#session = {
        credential: parsed.payload.sessionCredential,
        expiresAt: parsed.payload.expiresAt,
      };
      this.#sendConnect();
      return;
    }
    if (parsed.type === "aiDm.connected") {
      if (parsed.payload.userId !== game.user.id || parsed.payload.clientId !== this.#clientId) {
        this.#session = null;
        this.#store.setConnection("authentication-failed", "Foundry identity did not match.");
        this.#socket?.close(4003, "Identity mismatch");
        return;
      }
      if (parsed.payload.worldId !== (game.world?.id ?? "unknown-world")) {
        this.#session = null;
        this.#store.setConnection("authentication-failed", "Foundry world did not match.");
        this.#socket?.close(4003, "World mismatch");
        return;
      }
      this.#reconnectAttempt = 0;
      const renewed = this.#renewingSession;
      this.#renewingSession = false;
      this.#suppressStatusRefresh = renewed;
      this.#store.setAuthenticated(parsed.payload.lane, "Connected");
      this.#suppressStatusRefresh = false;
      this.#scheduleSessionRenewal();
      if (renewed) return; // No model discovery, policy write or action replay on renewal.
      this.send({
        type: "aiDm.history.fetch",
        payload: { requestId: crypto.randomUUID(), limit: 100 },
      });
      if (parsed.payload.lane === "gm") {
        void this.#statusRefresh.open().catch(() => undefined);
        this.send({
          type: "aiDm.player-requests.policy.set",
          payload: {
            requestId: crypto.randomUUID(),
            allowAll: Boolean(game.settings.get(MODULE_ID, "allowAllPlayerRequests")),
          },
        });
        this.send({
          type: "aiDm.player-requests.status",
          payload: { requestId: crypto.randomUUID() },
        });
      }
      return;
    }
    if (parsed.type === "aiDm.connection.refused") {
      this.#session = null;
      this.#store.setConnection(
        parsed.payload.retryable ? "disconnected" : "authentication-failed",
        parsed.payload.message,
      );
      this.#socket?.close(4001, "Connection refused");
      return;
    }
    if (parsed.type === "aiDm.chatgpt.signin.started") {
      const popup = this.#chatGptPopup;
      if (!popup || popup.closed) {
        ui.notifications.warn("The ChatGPT sign-in window was closed. Select Sign in again.");
        return;
      }
      popup.location.replace(parsed.payload.authorizationUrl);
      popup.focus();
      this.#startChatGptStatusPolling();
      return;
    }
    if (parsed.type === "aiDm.chatgpt.status" || parsed.type === "aiDm.player-requests.state") {
      if (parsed.type === "aiDm.chatgpt.status" && this.#retiredStatusRequests.has(parsed.payload.requestId)) return;
      if (parsed.type === "aiDm.chatgpt.status" && parsed.payload.requestId === this.#statusReply?.requestId) this.#statusReply.resolve();
      this.#store.applyControlMessage(parsed);
      if (
        parsed.type === "aiDm.chatgpt.status" &&
        parsed.payload.identityConnected &&
        this.#chatGptPopup
      ) {
        this.#stopChatGptStatusPolling();
        this.#chatGptPopup?.close();
        this.#chatGptPopup = null;
        if (parsed.payload.planUsageAuthorized) {
          ui.notifications.info("ChatGPT plan usage is authorized for this world.");
        } else {
          ui.notifications.warn("ChatGPT identity connected, but plan usage was not authorized.");
        }
      }
      return;
    }
    if (parsed.type === "aiDm.delivery") {
      if (
        parsed.payload.recipientUserId !== game.user.id ||
        parsed.payload.worldId !== (game.world?.id ?? "unknown-world")
      )
        return;
      const outcome = this.#store.applyDelivery(parsed.payload);
      if (outcome === "applied") {
        sessionStorage.setItem(
          RECIPIENT_CURSOR_KEY,
          String(this.#store.state.lastRecipientSequence),
        );
      }
      if (outcome === "gap") {
        const threadMessages = this.#store.state.messages.filter(
          ({ threadId }) => threadId === this.#store.state.activeThreadId,
        );
        const afterSequence = threadMessages.reduce(
          (maximum, { threadSequence }) => Math.max(maximum, threadSequence),
          0,
        );
        this.send({
          type: "aiDm.history.fetch",
          payload: {
            requestId: crypto.randomUUID(),
            ...(this.#store.state.activeThreadId
              ? { threadId: this.#store.state.activeThreadId }
              : {}),
            afterSequence,
            limit: 200,
          },
        });
      }
    }
  }

  #authenticateWithFoundry(challenge: {
    challengeId: string;
    challenge: string;
    connectionId: string;
    expiresAt: string;
  }): void {
    const worldId = game.world?.id;
    if (!worldId || Date.parse(challenge.expiresAt) <= Date.now()) {
      this.#failAuthentication("The local authentication challenge expired.");
      return;
    }
    const authenticatingSocket = this.#socket;
    let settled = false;
    const finish = (response: unknown): void => {
      if (settled || this.#socket !== authenticatingSocket) return;
      settled = true;
      if (this.#authAckTimer !== null) window.clearTimeout(this.#authAckTimer);
      this.#authAckTimer = null;
      if (!response || typeof response !== "object") {
        this.#failAuthentication("Foundry did not verify this browser session.");
        return;
      }
      const ack = response as { ok?: unknown; assertion?: unknown };
      if (ack.ok !== true || typeof ack.assertion !== "string" || !ack.assertion) {
        this.#failAuthentication("Foundry could not verify this browser session.");
        return;
      }
      this.#socket?.send(
        JSON.stringify({
          type: "aiDm.auth.assertion",
          payload: {
            protocolVersion: AI_DM_PROTOCOL_VERSION,
            clientId: this.#clientId,
            browserSessionId: this.#browserSessionId,
            moduleVersion: "0.1.0",
            assertion: ack.assertion,
          },
        }),
      );
    };
    this.#authAckTimer = window.setTimeout(() => finish(null), AUTH_ACK_TIMEOUT_MS);
    game.socket.emit(
      FOUNDRY_AUTH_EVENT,
      {
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        connectionId: challenge.connectionId,
        aiClientId: this.#clientId,
        browserSessionId: this.#browserSessionId,
        expectedWorldId: worldId,
      },
      finish,
    );
  }

  #failAuthentication(message: string): void {
    this.#clearSessionRenewal();
    this.#session = null;
    this.#store.setConnection("authentication-failed", this.#renewingSession
      ? `Foundry credential renewal failed: ${message} Reconnect as a Foundry GM.` : message);
    this.#renewingSession = false;
    this.#socket?.close(4003, "Foundry authentication failed");
  }

  #scheduleReconnect(): void {
    const delay = Math.min(30_000, 1_000 * 2 ** this.#reconnectAttempt++);
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
  }

  #requestChatGptStatus(): void {
    this.refreshChatGptStatus();
  }

  #fetchStatus(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const finish = (error?: Error): void => {
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", aborted);
        if (this.#statusReply?.requestId === requestId) this.#statusReply = null;
        this.#retiredStatusRequests.add(requestId);
        if (this.#retiredStatusRequests.size > 64) this.#retiredStatusRequests.delete(this.#retiredStatusRequests.values().next().value!);
        if (error) reject(error); else resolve();
      };
      const aborted = (): void => finish(new Error("Status refresh cancelled."));
      const timeout = window.setTimeout(() => finish(new Error("Status refresh timed out. Use Recheck connection.")), 5000);
      this.#statusReply = { requestId, resolve: () => finish(), reject: error => finish(error) };
      signal.addEventListener("abort", aborted, { once: true });
      if (!this.send({ type: "aiDm.chatgpt.status", payload: { requestId } })) finish(new Error("Connect as a Foundry GM to refresh status."));
    });
  }

  #startChatGptStatusPolling(): void {
    this.#stopChatGptStatusPolling();
    let attempt = 0;
    const check = (): void => {
      this.#chatGptStatusTimer = null;
      if (this.#chatGptPopup?.closed) {
        this.#requestChatGptStatus();
        this.#stopChatGptStatusPolling();
        this.#chatGptPopup = null;
        return;
      }
      this.#requestChatGptStatus();
      if (++attempt < 6 && this.#chatGptPopup) this.#chatGptStatusTimer = window.setTimeout(check, Math.min(15000, 1500 * 2 ** attempt));
    };
    this.#chatGptStatusTimer = window.setTimeout(check, 1500);
  }

  #stopChatGptStatusPolling(): void {
    if (this.#chatGptStatusTimer !== null) window.clearTimeout(this.#chatGptStatusTimer);
    this.#chatGptStatusTimer = null;
  }
}
