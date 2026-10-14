import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";

export const FOUNDRY_AI_AUTH_EVENT = "foundry-ai-dungeon-master.authenticate";

const ASSERTION_LIFETIME_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const REQUEST_FIELDS = Object.freeze({
  challengeId: 128,
  challenge: 256,
  connectionId: 128,
  aiClientId: 128,
  browserSessionId: 128,
  expectedWorldId: 128,
});
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const attachedServers = new WeakMap();

let pendingInitialization;

function normalizeSecret(sharedSecret) {
  const secret = Buffer.isBuffer(sharedSecret)
    ? Buffer.from(sharedSecret)
    : typeof sharedSecret === "string"
      ? Buffer.from(sharedSecret, "utf8")
      : null;

  if (!secret || secret.byteLength < 32) {
    throw new TypeError("The Foundry AI authentication shared secret must be at least 32 bytes.");
  }
  return secret;
}

function validateAiOrigin(aiOrigin) {
  if (aiOrigin === undefined) return;

  let parsed;
  try {
    parsed = new URL(aiOrigin);
  } catch {
    throw new TypeError("The AI origin must be a valid loopback HTTP origin.");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("The AI origin must be a valid loopback HTTP origin.");
  }
}

function isBoundedString(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })
  );
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  return Object.entries(REQUEST_FIELDS).every(([field, maximumLength]) =>
    isBoundedString(request[field], maximumLength),
  );
}

function getHeader(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function hasSameOriginHandshake(socket) {
  const headers = socket?.handshake?.headers;
  const origin = getHeader(headers, "origin");
  if (!origin || getHeader(headers, "sec-fetch-site") === "cross-site") return false;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsedOrigin.protocol)) return false;

  // Do not trust X-Forwarded-Host here. The broker cannot independently prove
  // that this Socket.IO request traversed Foundry's configured trusted proxy.
  const candidateHosts = [getHeader(headers, "host")]
    .filter((host) => typeof host === "string" && host.length > 0)
    .map((host) => host.toLowerCase());
  return candidateHosts.includes(parsedOrigin.host.toLowerCase());
}

function encodeAssertion(payload, sharedSecret) {
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signatureSegment = createHmac("sha256", sharedSecret)
    .update(payloadSegment, "ascii")
    .digest("base64url");
  return `${payloadSegment}.${signatureSegment}`;
}

function acknowledge(acknowledgement, response) {
  if (typeof acknowledgement !== "function") return;
  acknowledgement(response);
}

async function authenticateSocketRequest({
  socket,
  request,
  globals,
  sharedSecret,
  now,
  createJti,
}) {
  if (!hasSameOriginHandshake(socket)) return { ok: false, code: "invalid-origin" };
  if (!validateRequest(request)) return { ok: false, code: "invalid-request" };

  const game = globals.game;
  const worldId = game?.world?.id;
  if (!game?.ready || !isBoundedString(worldId, REQUEST_FIELDS.expectedWorldId)) {
    return { ok: false, code: "not-ready" };
  }
  if (request.expectedWorldId !== worldId) return { ok: false, code: "wrong-world" };

  const socketUserId = socket?.userId;
  const authenticatedSocketUserId = socket?.user?.id;
  if (
    !isBoundedString(socketUserId, 128) ||
    socketUserId !== authenticatedSocketUserId ||
    !isBoundedString(socket?.id, 128)
  ) {
    return { ok: false, code: "unauthenticated" };
  }

  let databaseUser;
  try {
    databaseUser = await globals.db?.User?.get(socketUserId);
  } catch {
    return { ok: false, code: "user-not-found" };
  }

  const activeWorldUser = game.users?.find?.((user) => user?.id === socketUserId);
  if (!databaseUser || databaseUser.id !== socketUserId || !activeWorldUser) {
    return { ok: false, code: "user-not-found" };
  }

  const isGm = databaseUser.isGM === true;
  const noneRole = globals.CONST?.USER_ROLES?.NONE ?? 0;
  const lane = isGm ? "gm" : databaseUser.role === noneRole ? "tv" : "player";
  const issuedAtMs = now();
  const payload = {
    version: 1,
    jti: createJti(),
    challengeId: request.challengeId,
    challenge: request.challenge,
    connectionId: request.connectionId,
    aiClientId: request.aiClientId,
    browserSessionId: request.browserSessionId,
    worldId,
    userId: socketUserId,
    lane,
    isGm,
    foundrySocketId: socket.id,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ASSERTION_LIFETIME_MS).toISOString(),
  };

  return { ok: true, assertion: encodeAssertion(payload, sharedSecret) };
}

/**
 * Attach the authentication broker to a concrete Foundry Socket.IO server.
 * This export exists to make the security boundary independently testable.
 */
export function attachFoundryAiAuthBroker({
  socketServer,
  sharedSecret,
  globals = globalThis,
  now = Date.now,
  createJti = randomUUID,
  aiOrigin,
} = {}) {
  if (!socketServer || typeof socketServer.on !== "function") {
    throw new TypeError("A Foundry Socket.IO server is required.");
  }
  const existing = attachedServers.get(socketServer);
  if (existing) return existing;

  validateAiOrigin(aiOrigin);
  const secret = normalizeSecret(sharedSecret);
  const socketListeners = new Map();

  const attachSocket = (socket) => {
    if (!socket || typeof socket.on !== "function" || socketListeners.has(socket)) return;

    const listener = async (request, acknowledgement) => {
      let response;
      try {
        response = await authenticateSocketRequest({
          socket,
          request,
          globals,
          sharedSecret: secret,
          now,
          createJti,
        });
      } catch {
        response = { ok: false, code: "internal-error" };
      }
      acknowledge(acknowledgement, response);
    };
    const disconnectListener = () => detachSocket(socket);

    socketListeners.set(socket, { listener, disconnectListener });
    socket.on(FOUNDRY_AI_AUTH_EVENT, listener);
    socket.once?.("disconnect", disconnectListener);
  };

  const detachSocket = (socket) => {
    const listeners = socketListeners.get(socket);
    if (!listeners) return;
    socket.off?.(FOUNDRY_AI_AUTH_EVENT, listeners.listener);
    socket.off?.("disconnect", listeners.disconnectListener);
    socketListeners.delete(socket);
  };

  const connectionListener = (socket) => attachSocket(socket);
  socketServer.on("connection", connectionListener);

  const existingSockets =
    socketServer.sockets?.sockets?.values?.() ?? globals.config?.sockets?.values?.() ?? [];
  for (const socket of existingSockets) attachSocket(socket);

  const handle = Object.freeze({
    dispose() {
      socketServer.off?.("connection", connectionListener);
      for (const socket of [...socketListeners.keys()]) detachSocket(socket);
      secret.fill(0);
      attachedServers.delete(socketServer);
    },
  });
  attachedServers.set(socketServer, handle);
  return handle;
}

/**
 * Wait for Foundry to construct its Socket.IO server, then attach exactly once.
 */
export function initializeFoundryAiAuthBroker({
  sharedSecret,
  aiOrigin,
  globals = globalThis,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (pendingInitialization) return pendingInitialization;

  validateAiOrigin(aiOrigin);
  const secret = normalizeSecret(sharedSecret);
  const startedAt = Date.now();

  const initialization = new Promise((resolve, reject) => {
    const inspect = () => {
      const socketServer = globals.express?.io;
      if (socketServer && typeof socketServer.on === "function") {
        try {
          const attachment = attachFoundryAiAuthBroker({
            socketServer,
            sharedSecret: secret,
            globals,
            aiOrigin,
          });
          resolve(
            Object.freeze({
              dispose() {
                attachment.dispose();
                if (pendingInitialization === initialization) pendingInitialization = undefined;
              },
            }),
          );
        } catch (error) {
          reject(error);
        } finally {
          secret.fill(0);
        }
        return;
      }

      if (Date.now() - startedAt >= waitTimeoutMs) {
        secret.fill(0);
        reject(new Error("Foundry Socket.IO did not become available before the broker timeout."));
        return;
      }

      const timer = setTimeout(inspect, pollIntervalMs);
      timer.unref?.();
    };
    inspect();
  });
  pendingInitialization = initialization;
  void initialization.catch(() => {
    if (pendingInitialization === initialization) pendingInitialization = undefined;
  });

  return pendingInitialization;
}
