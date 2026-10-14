import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  attachFoundryAiAuthBroker,
  FOUNDRY_AI_AUTH_EVENT,
  initializeFoundryAiAuthBroker,
} from "./foundry-ai-auth-broker.mjs";

const SECRET = "a-deterministic-test-secret-with-at-least-32-bytes";
const NOW = Date.parse("2026-09-30T00:00:00.000Z");
const REQUEST = Object.freeze({
  challengeId: "challenge-id",
  challenge: "challenge-value",
  connectionId: "ai-connection",
  aiClientId: "ai-client",
  browserSessionId: "browser-session",
  expectedWorldId: "world-one",
});

class MockSocket extends EventEmitter {
  constructor({ id = "foundry-socket", user } = {}) {
    super();
    this.id = id;
    this.user = user;
    this.userId = user?.id;
    this.handshake = {
      headers: {
        host: "foundry.example.test:30000",
        origin: "https://foundry.example.test:30000",
        "sec-fetch-site": "same-origin",
      },
    };
  }
}

class MockSocketServer extends EventEmitter {
  constructor(existingSockets = []) {
    super();
    this.sockets = { sockets: new Map(existingSockets.map((socket) => [socket.id, socket])) };
  }
}

function createGlobals(users, { ready = true, worldId = "world-one" } = {}) {
  return {
    CONST: { USER_ROLES: { NONE: 0 } },
    game: {
      ready,
      world: worldId ? { id: worldId } : null,
      users,
    },
    db: {
      User: {
        async get(id) {
          return users.find((user) => user.id === id) ?? null;
        },
      },
    },
  };
}

function decodeAndVerify(assertion) {
  const [payloadSegment, signatureSegment, extra] = assertion.split(".");
  assert.equal(extra, undefined);
  const expectedSignature = createHmac("sha256", SECRET)
    .update(payloadSegment, "ascii")
    .digest("base64url");
  assert.equal(signatureSegment, expectedSignature);
  return JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
}

async function authenticate({
  user,
  users = [user],
  request = REQUEST,
  mutateSocket,
  globals,
} = {}) {
  const socket = new MockSocket({ user });
  mutateSocket?.(socket);
  const socketServer = new MockSocketServer([socket]);
  const handle = attachFoundryAiAuthBroker({
    socketServer,
    sharedSecret: SECRET,
    globals: globals ?? createGlobals(users),
    now: () => NOW,
    createJti: () => "deterministic-jti",
    aiOrigin: "http://127.0.0.1:8787",
  });
  try {
    return await new Promise((resolve) => socket.emit(FOUNDRY_AI_AUTH_EVENT, request, resolve));
  } finally {
    handle.dispose();
  }
}

test("issues a signed, short-lived assertion from authoritative GM identity", async () => {
  const user = { id: "gm-user", role: 4, isGM: true };
  const response = await authenticate({ user });
  assert.equal(response.ok, true);

  const payload = decodeAndVerify(response.assertion);
  assert.deepEqual(payload, {
    version: 1,
    jti: "deterministic-jti",
    challengeId: REQUEST.challengeId,
    challenge: REQUEST.challenge,
    connectionId: REQUEST.connectionId,
    aiClientId: REQUEST.aiClientId,
    browserSessionId: REQUEST.browserSessionId,
    worldId: "world-one",
    userId: "gm-user",
    lane: "gm",
    isGm: true,
    foundrySocketId: "foundry-socket",
    issuedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-09-30T00:00:30.000Z",
  });
  assert.equal(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt), 30_000);
});

test("issues restricted player and TV assertions from database roles", async (t) => {
  await t.test("player", async () => {
    const response = await authenticate({ user: { id: "player", role: 1, isGM: false } });
    const payload = decodeAndVerify(response.assertion);
    assert.equal(payload.lane, "player");
    assert.equal(payload.isGm, false);
  });

  await t.test("TV", async () => {
    const response = await authenticate({ user: { id: "tv", role: 0, isGM: false } });
    const payload = decodeAndVerify(response.assertion);
    assert.equal(payload.lane, "tv");
    assert.equal(payload.isGm, false);
  });
});

test("ignores browser-supplied role, GM, world, and user claims", async () => {
  const response = await authenticate({
    user: { id: "player", role: 1, isGM: false },
    request: {
      ...REQUEST,
      userId: "attacker-selected-user",
      worldId: "attacker-selected-world",
      lane: "gm",
      isGm: true,
    },
  });
  const payload = decodeAndVerify(response.assertion);
  assert.equal(payload.userId, "player");
  assert.equal(payload.worldId, "world-one");
  assert.equal(payload.lane, "player");
  assert.equal(payload.isGm, false);
});

test("rejects nonexistent users, wrong worlds, and unavailable Foundry state", async (t) => {
  await t.test("nonexistent user", async () => {
    const response = await authenticate({
      user: { id: "missing", role: 4, isGM: true },
      users: [],
    });
    assert.deepEqual(response, { ok: false, code: "user-not-found" });
  });

  await t.test("wrong world", async () => {
    const response = await authenticate({
      user: { id: "gm", role: 4, isGM: true },
      request: { ...REQUEST, expectedWorldId: "world-two" },
    });
    assert.deepEqual(response, { ok: false, code: "wrong-world" });
  });

  await t.test("not ready", async () => {
    const user = { id: "gm", role: 4, isGM: true };
    const response = await authenticate({
      user,
      globals: createGlobals([user], { ready: false }),
    });
    assert.deepEqual(response, { ok: false, code: "not-ready" });
  });
});

test("rejects socket identity mismatch and cross-origin clients", async (t) => {
  const user = { id: "gm", role: 4, isGM: true };

  await t.test("socket identity mismatch", async () => {
    const response = await authenticate({
      user,
      mutateSocket(socket) {
        socket.userId = "different-user";
      },
    });
    assert.deepEqual(response, { ok: false, code: "unauthenticated" });
  });

  await t.test("cross-origin", async () => {
    const response = await authenticate({
      user,
      mutateSocket(socket) {
        socket.handshake.headers.origin = "https://malicious.example.test";
        socket.handshake.headers["sec-fetch-site"] = "cross-site";
        socket.handshake.headers["x-forwarded-host"] = "malicious.example.test";
      },
    });
    assert.deepEqual(response, { ok: false, code: "invalid-origin" });
  });
});

test("initialization is idempotent and dispose removes listeners", () => {
  const socketServer = new MockSocketServer();
  const globals = createGlobals([]);
  const first = attachFoundryAiAuthBroker({ socketServer, sharedSecret: SECRET, globals });
  const second = attachFoundryAiAuthBroker({ socketServer, sharedSecret: SECRET, globals });
  assert.equal(first, second);
  assert.equal(socketServer.listenerCount("connection"), 1);
  first.dispose();
  assert.equal(socketServer.listenerCount("connection"), 0);
});

test("validation failures and source contain no shared-secret value", async () => {
  const response = await authenticate({
    user: { id: "gm", role: 4, isGM: true },
    request: { ...REQUEST, challenge: "x".repeat(257) },
  });
  assert.deepEqual(response, { ok: false, code: "invalid-request" });
  assert.doesNotMatch(JSON.stringify(response), new RegExp(SECRET));

  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./foundry-ai-auth-broker.mjs", import.meta.url), "utf8"),
  );
  assert.equal(source.includes(SECRET), false);
});

test("initializer waits for Foundry Socket.IO and cleanup permits reinitialization", async () => {
  const globals = createGlobals([]);
  const firstServer = new MockSocketServer();
  const firstInitialization = initializeFoundryAiAuthBroker({
    sharedSecret: SECRET,
    globals,
    waitTimeoutMs: 1_000,
    pollIntervalMs: 1,
  });
  setTimeout(() => {
    globals.express = { io: firstServer };
  }, 5);
  const firstHandle = await firstInitialization;
  assert.equal(firstServer.listenerCount("connection"), 1);
  firstHandle.dispose();
  assert.equal(firstServer.listenerCount("connection"), 0);

  const secondServer = new MockSocketServer();
  globals.express.io = secondServer;
  const secondHandle = await initializeFoundryAiAuthBroker({
    sharedSecret: SECRET,
    globals,
    waitTimeoutMs: 1_000,
    pollIntervalMs: 1,
  });
  assert.equal(secondServer.listenerCount("connection"), 1);
  secondHandle.dispose();
});
