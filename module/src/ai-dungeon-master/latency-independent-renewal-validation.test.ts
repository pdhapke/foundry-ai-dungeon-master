import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import { AiDmClientStore } from "./store.js";
import { AiDmTransport } from "./transport.js";

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Listener[]>();
  closeCode: number | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(code = 1000): void {
    this.closeCode = code;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close");
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }

  message(message: unknown): void {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  dispatch(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const scheduled: Array<{ delay: number; callback: () => void }> = [];
const storageWrites: Array<[string, string]> = [];
const storageRemovals: string[] = [];
let foundryAck: unknown = { ok: true, assertion: `${"a".repeat(64)}.${"b".repeat(64)}` };
let authenticatedLane: "gm" | "player" = "gm";

function parsedMessages(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

function installBrowserGlobals(): void {
  FakeWebSocket.instances = [];
  scheduled.length = 0;
  storageWrites.length = 0;
  storageRemovals.length = 0;
  foundryAck = { ok: true, assertion: `${"a".repeat(64)}.${"b".repeat(64)}` };
  authenticatedLane = "gm";
  Object.assign(globalThis, {
    WebSocket: FakeWebSocket,
    sessionStorage: {
      getItem: () => null,
      setItem: (key: string, value: string) => storageWrites.push([key, value]),
      removeItem: (key: string) => storageRemovals.push(key),
    },
    window: {
      addEventListener: () => undefined,
      setTimeout: (callback: () => void, delay: number) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      clearTimeout: () => undefined,
      setInterval: () => 1,
      clearInterval: () => undefined,
      open: () => null,
    },
    game: {
      user: { id: "user-1", isGM: true },
      world: { id: "world-1" },
      settings: {
        get: (_moduleId: string, key: string) =>
          key === "serverUrl" ? "ws://127.0.0.1:6010" : false,
      },
      socket: {
        emit: (
          event: string,
          payload: Record<string, unknown>,
          acknowledgement: (response: unknown) => void,
        ) => {
          assert.equal(event, "foundry-ai-dungeon-master.authenticate");
          assert.equal(payload["expectedWorldId"], "world-1");
          assert.equal("isGM" in payload, false);
          assert.equal("userId" in payload, false);
          acknowledgement(foundryAck);
        },
      },
    },
    ui: { notifications: { info: () => undefined, warn: () => undefined, error: () => undefined } },
  });
  Object.assign(FakeWebSocket, {
    OPEN: FakeWebSocket.OPEN,
    CLOSING: FakeWebSocket.CLOSING,
  });
}

function authenticate(transport: AiDmTransport, store: AiDmClientStore): FakeWebSocket {
  transport.connect();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.open();
  const identify = parsedMessages(socket)[0];
  assert.equal(identify?.["type"], "aiDm.auth.identify");
  const identifyPayload = identify?.["payload"] as Record<string, unknown>;
  assert.equal("isGM" in identifyPayload, false);
  socket.message({
    type: "aiDm.auth.challenge",
    payload: {
      challengeId: "challenge-0001",
      challenge: "c".repeat(43),
      connectionId: "connection-0001",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });
  assert.equal(parsedMessages(socket)[1]?.["type"], "aiDm.auth.assertion");
  socket.message({
    type: "aiDm.auth.accepted",
    payload: {
      clientId: identifyPayload["clientId"],
      sessionCredential: "s".repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const connect = parsedMessages(socket)[2];
  assert.equal(connect?.["type"], "aiDm.connect");
  const connectPayload = connect?.["payload"] as Record<string, unknown>;
  socket.message({
    type: "aiDm.connected",
    payload: {
      clientId: connectPayload["clientId"],
      userId: "user-1",
      worldId: "world-1",
      lane: authenticatedLane,
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  assert.equal(store.state.connection, "connected");
  return socket;
}

void describe("AI Dungeon Master browser authentication", () => {
  beforeEach(installBrowserGlobals);

  void it("renews before expiry through a fresh bound challenge without replaying commands", () => {
    const store = new AiDmClientStore(), transport = new AiDmTransport(store);
    const old = authenticate(transport, store), original = transport.chatKitHeaders();
    const renewal = scheduled.find(t => t.delay > 25_000 && t.delay <= 30_000);
    assert.ok(renewal);
    renewal.callback();
    assert.equal(old.closeCode, 1000);
    assert.equal(store.state.connection, "authenticating");
    assert.throws(() => transport.chatKitHeaders(), /Renewing/);
    const fresh = FakeWebSocket.instances[1]; assert.ok(fresh); fresh.open();
    const identify = parsedMessages(fresh)[0]?.["payload"] as Record<string, unknown>;
    assert.equal(identify["clientId"], original["x-ai-dm-client"]);
    assert.equal(identify["browserSessionId"], original["x-ai-dm-browser-session"]);
    fresh.message({ type: "aiDm.auth.challenge", payload: { challengeId: "challenge-new", challenge: "d".repeat(43), connectionId: "connection-new", expiresAt: new Date(Date.now() + 30_000).toISOString() } });
    fresh.message({ type: "aiDm.auth.accepted", payload: { clientId: identify["clientId"], sessionCredential: "n".repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() } });
    fresh.message({ type: "aiDm.connected", payload: { clientId: identify["clientId"], userId: "user-1", worldId: "world-1", lane: "gm", sessionExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
    assert.equal(transport.chatKitHeaders()["x-ai-dm-session"], "n".repeat(43));
    assert.deepEqual(parsedMessages(fresh).map(m => m["type"]), ["aiDm.auth.identify", "aiDm.auth.assertion", "aiDm.connect"]);
    // Late old-socket data cannot overwrite the fresh session.
    old.message({ type: "aiDm.auth.accepted", payload: { clientId: identify["clientId"], sessionCredential: "x".repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() } });
    assert.equal(transport.chatKitHeaders()["x-ai-dm-session"], "n".repeat(43));
    transport.disconnect();
  });

  void it("expired submit requests renewal and sends no action; renewal failure has an explicit message", () => {
    const store = new AiDmClientStore(), transport = new AiDmTransport(store);
    const old = authenticate(transport, store), sent = old.sent.length;
    const actualNow = Date.now;
    try { Date.now = () => actualNow() + 120_000; assert.throws(() => transport.chatKitHeaders(), /expired/); }
    finally { Date.now = actualNow; }
    assert.equal(old.sent.length, sent);
    const fresh = FakeWebSocket.instances[1]; assert.ok(fresh); fresh.open();
    foundryAck = { ok: false };
    fresh.message({ type: "aiDm.auth.challenge", payload: { challengeId: "challenge-new", challenge: "d".repeat(43), connectionId: "connection-new", expiresAt: new Date(Date.now() + 30_000).toISOString() } });
    assert.equal(store.state.connection, "authentication-failed");
    assert.match(store.state.connectionMessage, /credential renewal failed/);
    assert.equal(parsedMessages(fresh).some(m => m["type"] === "aiDm.command"), false);
    transport.disconnect();
  });

  void it("disconnect cancels renewal and a late renewal callback cannot reconnect", () => {
    const store = new AiDmClientStore(), transport = new AiDmTransport(store);
    authenticate(transport, store);
    const renewal = scheduled.find(t => t.delay > 25_000 && t.delay <= 30_000); assert.ok(renewal);
    transport.disconnect(); renewal.callback();
    assert.equal(FakeWebSocket.instances.length, 1);
  });

  void it("supplies ChatKit headers only for a current authenticated GM without persisting credentials", () => {
    const store = new AiDmClientStore();
    const transport = new AiDmTransport(store);
    assert.throws(() => transport.chatKitHeaders(), /GM/);
    authenticate(transport, store);
    const headers = transport.chatKitHeaders();
    assert.equal(headers["x-ai-dm-session"], "s".repeat(43));
    assert.equal(headers["x-ai-dm-version"], "0.1.0");
    assert.ok(headers["x-ai-dm-client"]);
    assert.ok(headers["x-ai-dm-browser-session"]);
    assert.equal(storageWrites.length, 0);
    transport.disconnect();
    assert.throws(() => transport.chatKitHeaders(), /GM/);
  });

  void it("automatically authenticates a GM without browser role claims or persistent secrets", () => {
    const store = new AiDmClientStore();
    const transport = new AiDmTransport(store);
    const socket = authenticate(transport, store);
    assert.equal(store.state.authenticatedLane, "gm");
    assert.ok(
      parsedMessages(socket).some(
        ({ type, payload }) =>
          type === "aiDm.command" && (payload as { type?: unknown }).type === "aiDm.chatgpt.status",
      ),
    );
    assert.equal(storageWrites.length, 0);
    assert.deepEqual(storageRemovals, ["foundry-ai-dungeon-master.session.v1"]);
  });

  void it("does not treat identity-only ChatGPT sign-in as inference-ready", () => {
    const store = new AiDmClientStore();
    const transport = new AiDmTransport(store);
    const socket = authenticate(transport, store);
    socket.message({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-status-1",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: false,
        modelDiscoveryState: "not-authorized",
        availableModels: [],
        selectedModel: null,
        email: "gm@example.com",
      },
    });
    assert.equal(store.state.chatGpt.state, "identity-only");
    assert.equal(store.state.chatGpt.planUsageAuthorized, false);
    const messagesBeforePrompt = socket.sent.length;
    assert.equal(
      transport.send({
        type: "aiDm.prompt.submit",
        payload: {
          requestId: "request-prompt-1",
          text: "Do not run this.",
          requestedAudience: { kind: "private" },
          contextHints: {
            controlledTokenIds: [],
            controlledActorIds: [],
            targetTokenIds: [],
            selectedDocumentUuids: [],
          },
        },
      }),
      false,
    );
    assert.equal(socket.sent.length, messagesBeforePrompt);

    socket.message({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-status-2",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "available",
        availableModels: [
          { slug: "gpt-5.4-mini", displayName: "GPT-5.4 mini" },
          { slug: "gpt-5.4", displayName: "GPT-5.4" },
        ],
        selectedModel: "gpt-5.4-mini",
        email: "gm@example.com",
      },
    });
    assert.equal(store.state.chatGpt.state, "ready");
    assert.equal(
      transport.send({
        type: "aiDm.prompt.submit",
        payload: {
          requestId: "request-prompt-2",
          text: "This may run.",
          requestedAudience: { kind: "private" },
          contextHints: {
            controlledTokenIds: [],
            controlledActorIds: [],
            targetTokenIds: [],
            selectedDocumentUuids: [],
          },
        },
      }),
      true,
    );
  });

  void it("uses the server-authenticated player lane and blocks ChatGPT sign-in", () => {
    authenticatedLane = "player";
    const store = new AiDmClientStore();
    const transport = new AiDmTransport(store);
    const socket = authenticate(transport, store);
    assert.equal(store.state.authenticatedLane, "player");
    assert.equal(transport.beginChatGptSignIn(), false);
    assert.equal(
      parsedMessages(socket).some(
        ({ type, payload }) =>
          type === "aiDm.command" &&
          (payload as { type?: unknown }).type === "aiDm.chatgpt.signin.begin",
      ),
      false,
    );
  });

  void it("fails closed on a malformed Foundry acknowledgement", () => {
    foundryAck = { ok: true, assertion: "" };
    const store = new AiDmClientStore();
    const transport = new AiDmTransport(store);
    transport.connect();
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.open();
    socket.message({
      type: "aiDm.auth.challenge",
      payload: {
        challengeId: "challenge-0001",
        challenge: "c".repeat(43),
        connectionId: "connection-0001",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
    });
    assert.equal(socket.closeCode, 4003);
    assert.equal(store.state.connection, "authentication-failed");
    assert.equal(
      parsedMessages(socket).some(({ type }) => type === "aiDm.auth.assertion"),
      false,
    );
    assert.equal(transport.beginChatGptSignIn(), false);
  });

  void it("has no manual enrollment controls", () => {
    const template = readFileSync(
      new URL("../../templates/ai-dungeon-master/application.hbs", import.meta.url),
      "utf8",
    );
    assert.equal(template.includes("enrollmentCode"), false);
    assert.equal(template.includes('data-action="enroll"'), false);
    assert.equal(template.includes("One-time enrollment"), false);
  });

  void it("retries disconnects with bounded exponential backoff", () => {
    const transport = new AiDmTransport(new AiDmClientStore());
    transport.connect();
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.close(1006);
    assert.equal(scheduled.at(-1)?.delay, 1_000);
    scheduled.at(-1)?.callback();
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.close(1006);
    assert.equal(scheduled.at(-1)?.delay, 2_000);
    for (let index = 0; index < 10; index += 1) {
      scheduled.at(-1)?.callback();
      FakeWebSocket.instances.at(-1)?.close(1006);
    }
    assert.equal(scheduled.at(-1)?.delay, 30_000);
  });
});
void describe('independent renewal isolation',()=>{
 beforeEach(installBrowserGlobals);
 void it('fresh renewal world mismatch cannot restore old authority or replay action',()=>{
 const store=new AiDmClientStore(),transport=new AiDmTransport(store);const old=authenticate(transport,store);const renewal=scheduled.find(t=>t.delay>25000&&t.delay<=30000)!;renewal.callback();const fresh=FakeWebSocket.instances[1]!;fresh.open();const identity=parsedMessages(fresh)[0]!['payload'] as Record<string,unknown>;
 fresh.message({type:'aiDm.auth.accepted',payload:{clientId:identity['clientId'],sessionCredential:'n'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()}});
 fresh.message({type:'aiDm.connected',payload:{clientId:identity['clientId'],userId:'user-1',worldId:'other-world',lane:'gm',sessionExpiresAt:new Date(Date.now()+60000).toISOString()}});
 assert.equal(store.state.connection,'authentication-failed');assert.throws(()=>transport.chatKitHeaders());assert.ok(!parsedMessages(fresh).some(m=>m['type']==='aiDm.command'));assert.equal(old.closeCode,1000);transport.disconnect();
 });
 void it('fresh player lane cannot reuse prior GM ChatKit authority',()=>{
 const store=new AiDmClientStore(),transport=new AiDmTransport(store);authenticate(transport,store);const renewal=scheduled.find(t=>t.delay>25000&&t.delay<=30000)!;renewal.callback();const fresh=FakeWebSocket.instances[1]!;fresh.open();const identity=parsedMessages(fresh)[0]!['payload'] as Record<string,unknown>;
 fresh.message({type:'aiDm.auth.accepted',payload:{clientId:identity['clientId'],sessionCredential:'p'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()}});
 fresh.message({type:'aiDm.connected',payload:{clientId:identity['clientId'],userId:'user-1',worldId:'world-1',lane:'player',sessionExpiresAt:new Date(Date.now()+60000).toISOString()}});
 assert.equal(store.state.authenticatedLane,'player');assert.throws(()=>transport.chatKitHeaders(),/GM/);assert.ok(!parsedMessages(fresh).some(m=>m['type']==='aiDm.command'));transport.disconnect();
 });
});
