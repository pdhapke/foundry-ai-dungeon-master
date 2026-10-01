import {
  AI_DM_PROTOCOL_VERSION,
  aiDmTransportServerMessageSchema,
  type AiDmClientMessage,
  type AiDmTransportServerMessage,
} from "@foundry-ai-dungeon-master/shared";

import { AiDmClientStore } from "./store.js";

const MODULE_ID = "foundry-ai-dungeon-master";
const RECIPIENT_CURSOR_KEY = `${MODULE_ID}.recipient-cursor.v1`;
const LEGACY_SESSION_KEY = `${MODULE_ID}.session.v1`;
const FOUNDRY_AUTH_EVENT = "foundry-ai-dungeon-master.authenticate";
const AUTH_ACK_TIMEOUT_MS = 5_000;

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
  #chatGptPopup: Window | null = null;
  #chatGptStatusTimer: number | null = null;

  constructor(store: AiDmClientStore) {
    this.#store = store;
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
        this.#requestChatGptStatus();
      }
    });
  }

  connect(): void {
    this.#manualClose = false;
    sessionStorage.removeItem(LEGACY_SESSION_KEY);
    const cursor = Number(sessionStorage.getItem(RECIPIENT_CURSOR_KEY) ?? "0");
    if (Number.isSafeInteger(cursor) && cursor >= 0) this.#store.resetRecipientSequence(cursor);
    this.#open();
  }

  disconnect(): void {
    this.#manualClose = true;
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    if (this.#authAckTimer !== null) window.clearTimeout(this.#authAckTimer);
    this.#authAckTimer = null;
    this.#socket?.close(1000, "Client closed");
    this.#socket = null;
    this.#session = null;
    this.#stopChatGptStatusPolling();
    this.#chatGptPopup?.close();
    this.#chatGptPopup = null;
  }

  /** Short-lived Foundry credential stays in memory and is used only for gateway requests. */
  chatKitHeaders(): Record<string, string> {
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
      if (this.#session && Date.parse(this.#session.expiresAt) > Date.now() + 5_000)
        this.#sendConnect();
      else this.#sendIdentityRequest();
    });
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => {
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
      this.#store.setAuthenticated(parsed.payload.lane, "Connected");
      this.send({
        type: "aiDm.history.fetch",
        payload: { requestId: crypto.randomUUID(), limit: 100 },
      });
      if (parsed.payload.lane === "gm") {
        this.send({ type: "aiDm.chatgpt.status", payload: { requestId: crypto.randomUUID() } });
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
    let settled = false;
    const finish = (response: unknown): void => {
      if (settled) return;
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
    this.#session = null;
    this.#store.setConnection("authentication-failed", message);
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
    this.send({
      type: "aiDm.chatgpt.status",
      payload: { requestId: crypto.randomUUID() },
    });
  }

  #startChatGptStatusPolling(): void {
    this.#stopChatGptStatusPolling();
    this.#chatGptStatusTimer = window.setInterval(() => {
      if (this.#chatGptPopup?.closed) {
        this.#requestChatGptStatus();
        this.#stopChatGptStatusPolling();
        this.#chatGptPopup = null;
        return;
      }
      this.#requestChatGptStatus();
    }, 1_500);
  }

  #stopChatGptStatusPolling(): void {
    if (this.#chatGptStatusTimer !== null) window.clearInterval(this.#chatGptStatusTimer);
    this.#chatGptStatusTimer = null;
  }
}
