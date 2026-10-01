import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";

import {
  aiDmTransportClientMessageSchema,
  type AiDmAuthenticatedIdentity,
  type AiDmClientMessage,
  type AiDmServerDelivery,
  type AiDmTransportServerMessage,
} from "@foundry-ai-dungeon-master/shared";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  AiDmFoundrySessionError,
  type AiDmLocalSessionProof,
  type AiDmFoundrySessionService,
} from "../auth/foundry-session.js";

export interface AiDmCommandHandler {
  handle(
    command: AiDmClientMessage,
    identity: AiDmAuthenticatedIdentity,
    sessionProof: AiDmLocalSessionProof,
  ): Promise<AiDmTransportServerMessage | void>;
}

interface ConnectionState {
  socket: WebSocket;
  connectionId: string;
  origin: string;
  identity: AiDmAuthenticatedIdentity | null;
  clientId: string | null;
  browserSessionId: string | null;
  sessionCredential: string | null;
  sessionExpiresAt: string | null;
  sessionProof: AiDmLocalSessionProof | null;
  moduleVersion: string | null;
  commandChain: Promise<void>;
  authenticationTimer: NodeJS.Timeout;
}

function send(socket: WebSocket, message: AiDmTransportServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function refusal(socket: WebSocket, code: string, message: string, retryable: boolean): void {
  send(socket, {
    type: "aiDm.connection.refused",
    payload: { code, message, retryable },
  });
}

function exactOriginAllowed(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

export class AiDmWebSocketGateway {
  readonly #server: WebSocketServer;
  readonly #enrollment: AiDmFoundrySessionService;
  readonly #commands: AiDmCommandHandler;
  readonly #connections = new Set<ConnectionState>();
  readonly #byClientId = new Map<string, ConnectionState>();

  constructor(
    httpServer: HttpServer,
    options: {
      enrollment: AiDmFoundrySessionService;
      commands: AiDmCommandHandler;
      allowedOrigins: readonly string[];
    },
  ) {
    this.#enrollment = options.enrollment;
    this.#commands = options.commands;
    const allowedOrigins = new Set(options.allowedOrigins);
    this.#server = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws" || !exactOriginAllowed(request.headers.origin, allowedOrigins)) {
        socket.destroy();
        return;
      }
      this.#server.handleUpgrade(request, socket, head, (webSocket) => {
        this.#server.emit("connection", webSocket, request);
      });
    });
    this.#server.on("connection", (socket, request) => this.#accept(socket, request));
  }

  sendDelivery(delivery: AiDmServerDelivery): number {
    let delivered = 0;
    for (const connection of this.#connections) {
      if (
        connection.identity?.userId !== delivery.recipientUserId ||
        connection.identity.worldId !== delivery.worldId
      )
        continue;
      send(connection.socket, { type: "aiDm.delivery", payload: delivery });
      delivered += 1;
    }
    return delivered;
  }

  sendToUser(worldId: string, userId: string, message: AiDmTransportServerMessage): number {
    let delivered = 0;
    for (const connection of this.#connections) {
      if (connection.identity?.worldId !== worldId || connection.identity.userId !== userId)
        continue;
      send(connection.socket, message);
      delivered += 1;
    }
    return delivered;
  }

  sendToGms(worldId: string, message: AiDmTransportServerMessage): number {
    let delivered = 0;
    for (const connection of this.#connections) {
      if (connection.identity?.worldId !== worldId || !connection.identity.isGm) continue;
      send(connection.socket, message);
      delivered += 1;
    }
    return delivered;
  }

  /** Returns only a currently connected GM whose durable local session still validates. */
  currentGm(worldId: string): AiDmAuthenticatedIdentity | null {
    for (const connection of this.#connections) {
      if (
        connection.socket.readyState !== WebSocket.OPEN ||
        connection.identity?.worldId !== worldId ||
        !connection.identity.isGm ||
        connection.identity.lane !== "gm" ||
        !connection.sessionProof
      ) {
        continue;
      }
      try {
        const current = this.#enrollment.validateProof(connection.sessionProof);
        connection.identity = current.identity;
        connection.sessionProof = current;
        return current.identity;
      } catch {
        this.#invalidate(connection, "GM session is no longer valid");
      }
    }
    return null;
  }

  close(): void {
    for (const connection of this.#connections) connection.socket.close(1001, "Server shutdown");
    this.#server.close();
  }

  #accept(socket: WebSocket, request: IncomingMessage): void {
    const connection: ConnectionState = {
      socket,
      connectionId: randomUUID(),
      origin: request.headers.origin!,
      identity: null,
      clientId: null,
      browserSessionId: null,
      sessionCredential: null,
      sessionExpiresAt: null,
      sessionProof: null,
      moduleVersion: null,
      commandChain: Promise.resolve(),
      authenticationTimer: setTimeout(() => {
        refusal(socket, "AUTHENTICATION_TIMEOUT", "Authentication timed out.", true);
        socket.close(4001, "Authentication timeout");
      }, 10_000),
    };
    this.#connections.add(connection);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text messages required");
        return;
      }
      connection.commandChain = connection.commandChain
        .then(() => this.#onMessage(connection, rawText(data)))
        .catch(() => {
          refusal(socket, "COMMAND_FAILED", "The command could not be accepted.", true);
        });
    });
    socket.on("close", () => {
      clearTimeout(connection.authenticationTimer);
      this.#connections.delete(connection);
      this.#clearConnectionIdentity(connection);
    });
  }

  async #onMessage(connection: ConnectionState, raw: string): Promise<void> {
    let unknownMessage: unknown;
    try {
      unknownMessage = JSON.parse(raw);
    } catch {
      refusal(connection.socket, "INVALID_MESSAGE", "Message is not valid JSON.", false);
      return;
    }
    const parsed = aiDmTransportClientMessageSchema.safeParse(unknownMessage);
    if (!parsed.success) {
      refusal(connection.socket, "INVALID_MESSAGE", "Message does not match the protocol.", false);
      return;
    }
    const message = parsed.data;
    try {
      if (message.type === "aiDm.auth.identify") {
        if (connection.identity) return;
        if (connection.clientId) {
          refusal(
            connection.socket,
            "CHALLENGE_INVALID",
            "Challenge was already requested.",
            false,
          );
          return;
        }
        connection.clientId = message.payload.clientId;
        connection.browserSessionId = message.payload.browserSessionId;
        connection.moduleVersion = message.payload.moduleVersion;
        const result = this.#enrollment.issueChallenge({
          connectionId: connection.connectionId,
          origin: connection.origin,
          clientId: message.payload.clientId,
          browserSessionId: message.payload.browserSessionId,
          worldId: message.payload.worldId,
          moduleVersion: message.payload.moduleVersion,
        });
        send(connection.socket, {
          type: "aiDm.auth.challenge",
          payload: result,
        });
        return;
      }
      if (message.type === "aiDm.auth.assertion") {
        if (connection.identity) return;
        if (
          !connection.clientId ||
          !connection.browserSessionId ||
          connection.clientId !== message.payload.clientId ||
          connection.browserSessionId !== message.payload.browserSessionId
        ) {
          refusal(
            connection.socket,
            "ASSERTION_IDENTITY_MISMATCH",
            "Assertion binding does not match.",
            false,
          );
          return;
        }
        const result = this.#enrollment.exchangeAssertion({
          assertion: message.payload.assertion,
          connectionId: connection.connectionId,
          origin: connection.origin,
          clientId: message.payload.clientId,
          browserSessionId: message.payload.browserSessionId,
          moduleVersion: message.payload.moduleVersion,
        });
        send(connection.socket, {
          type: "aiDm.auth.accepted",
          payload: {
            clientId: message.payload.clientId,
            sessionCredential: result.sessionCredential,
            expiresAt: result.expiresAt,
          },
        });
        return;
      }
      if (message.type === "aiDm.connect") {
        if (connection.identity) return;
        const authenticated = this.#enrollment.authenticate(message.payload);
        this.#bind(
          connection,
          message.payload.clientId,
          message.payload.browserSessionId,
          message.payload.sessionCredential,
          message.payload.moduleVersion,
          authenticated.identity,
          authenticated.expiresAt,
          authenticated,
        );
        clearTimeout(connection.authenticationTimer);
        send(connection.socket, {
          type: "aiDm.connected",
          payload: {
            clientId: message.payload.clientId,
            userId: authenticated.identity.userId,
            worldId: authenticated.identity.worldId,
            lane: authenticated.identity.lane,
            sessionExpiresAt: authenticated.expiresAt,
          },
        });
        return;
      }
      if (!connection.identity) {
        refusal(
          connection.socket,
          "AUTHENTICATION_REQUIRED",
          "Authenticate before commands.",
          false,
        );
        return;
      }
      if (
        !connection.sessionCredential ||
        !connection.browserSessionId ||
        !connection.sessionExpiresAt
      ) {
        refusal(connection.socket, "SESSION_EXPIRED", "Session has expired.", true);
        connection.socket.close(4001, "Session expired");
        return;
      }
      const current = this.#enrollment.authenticate({
        sessionCredential: connection.sessionCredential,
        clientId: connection.clientId!,
        browserSessionId: connection.browserSessionId,
        moduleVersion: connection.moduleVersion!,
      });
      const response = await this.#commands.handle(
        message.payload as AiDmClientMessage,
        current.identity,
        current,
      );
      if (response) send(connection.socket, response);
    } catch (error) {
      if (error instanceof AiDmFoundrySessionError) {
        refusal(connection.socket, error.code, error.message, error.code === "SESSION_EXPIRED");
        if (error.code.startsWith("SESSION_")) this.#invalidate(connection, error.message);
        return;
      }
      refusal(connection.socket, "COMMAND_FAILED", "The command could not be accepted.", true);
    }
  }

  #bind(
    connection: ConnectionState,
    clientId: string,
    browserSessionId: string,
    sessionCredential: string,
    moduleVersion: string,
    identity: AiDmAuthenticatedIdentity,
    sessionExpiresAt: string,
    sessionProof: AiDmLocalSessionProof,
  ): void {
    const previous = this.#byClientId.get(clientId);
    if (previous && previous !== connection)
      this.#invalidate(previous, "Superseded connection", 4002);
    connection.clientId = clientId;
    connection.browserSessionId = browserSessionId;
    connection.sessionCredential = sessionCredential;
    connection.moduleVersion = moduleVersion;
    connection.sessionExpiresAt = sessionExpiresAt;
    connection.sessionProof = sessionProof;
    connection.identity = identity;
    this.#byClientId.set(clientId, connection);
  }

  #clearConnectionIdentity(connection: ConnectionState): void {
    if (connection.clientId && this.#byClientId.get(connection.clientId) === connection) {
      this.#byClientId.delete(connection.clientId);
    }
    connection.identity = null;
    connection.sessionCredential = null;
    connection.sessionExpiresAt = null;
    connection.sessionProof = null;
  }

  #invalidate(connection: ConnectionState, reason: string, code = 4001): void {
    this.#clearConnectionIdentity(connection);
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.close(code, reason);
  }
}
