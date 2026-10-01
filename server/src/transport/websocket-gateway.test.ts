import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import type { AiDmServerDelivery } from "@foundry-ai-dungeon-master/shared";
import { WebSocket, type RawData } from "ws";

import { InMemoryAiDmEnrollmentRepository } from "../auth/enrollment.js";
import { AiDmFoundrySessionService } from "../auth/foundry-session.js";
import { AiDmWebSocketGateway } from "./websocket-gateway.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data: RawData) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : Buffer.concat(data).toString("utf8");
      resolve(JSON.parse(text) as Record<string, unknown>);
    });
  });
}

async function connect(
  url: string,
  clientId: string,
  browserSessionId: string,
  sessionCredential: string,
): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Origin: "http://127.0.0.1:30000" } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const connected = nextMessage(socket);
  socket.send(
    JSON.stringify({
      type: "aiDm.connect",
      payload: {
        protocolVersion: 2,
        clientId,
        browserSessionId,
        sessionCredential,
        moduleVersion: "0.1.0",
      },
    }),
  );
  assert.equal((await connected)["type"], "aiDm.connected");
  return socket;
}

function delivery(worldId: string): AiDmServerDelivery {
  return {
    protocolVersion: 2,
    deliveryId: `delivery-${worldId}`,
    recipientUserId: "same-user",
    recipientSequence: 1,
    worldId,
    threadId: null,
    runId: null,
    occurredAt: "2026-09-29T00:00:00.000Z",
    message: {
      type: "aiDm.run.failed",
      payload: { runId: "run-1", code: "TEST", message: "safe", retryable: false },
    },
  };
}

function issueSession(options: {
  enrollment: AiDmFoundrySessionService;
  assertionSecret: string;
  now: Date;
  clientId: string;
  worldId: string;
  isGm: boolean;
}): { clientId: string; browserSessionId: string; credential: string } {
  const browserSessionId = `browser_session_${options.clientId}`;
  const binding = {
    connectionId: `setup-${options.clientId}`,
    origin: "http://127.0.0.1:30000",
    clientId: options.clientId,
    browserSessionId,
    worldId: options.worldId,
    moduleVersion: "0.1.0",
  };
  const challenge = options.enrollment.issueChallenge(binding);
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      jti: randomBytes(16).toString("hex"),
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      connectionId: binding.connectionId,
      aiClientId: options.clientId,
      browserSessionId,
      worldId: options.worldId,
      userId: options.isGm ? `gm-${options.clientId}` : `player-${options.clientId}`,
      lane: options.isGm ? "gm" : "player",
      isGm: options.isGm,
      foundrySocketId: `socket-${options.clientId}`,
      issuedAt: options.now.toISOString(),
      expiresAt: new Date(options.now.getTime() + 30_000).toISOString(),
    }),
  ).toString("base64url");
  const assertion = `${body}.${createHmac("sha256", options.assertionSecret).update(body).digest("base64url")}`;
  const accepted = options.enrollment.exchangeAssertion({ ...binding, assertion });
  return { clientId: options.clientId, browserSessionId, credential: accepted.sessionCredential };
}

void describe("AI Dungeon Master WebSocket gateway", () => {
  void it("rejects missing and non-allowlisted Origins before WebSocket acceptance", async () => {
    const server = createServer();
    const gateway = new AiDmWebSocketGateway(server, {
      enrollment: new AiDmFoundrySessionService({
        repository: new InMemoryAiDmEnrollmentRepository(),
        moduleVersion: "0.1.0",
        assertionSecret: "b".repeat(32),
      }),
      commands: { handle: () => Promise.resolve() },
      allowedOrigins: ["http://127.0.0.1:30000"],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    closers.push(async () => {
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    for (const options of [undefined, { headers: { Origin: "http://localhost:30000" } }]) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
      await assert.rejects(
        new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        }),
      );
    }
  });

  void it("authorizes allow-all only through a connected, current, same-world GM session", async () => {
    let clock = new Date("2026-09-29T00:00:00.000Z");
    const assertionSecret = "b".repeat(32);
    const enrollment = new AiDmFoundrySessionService({
      repository: new InMemoryAiDmEnrollmentRepository(),
      moduleVersion: "0.1.0",
      assertionSecret,
      now: () => clock,
    });
    const server = createServer();
    const gateway = new AiDmWebSocketGateway(server, {
      enrollment,
      commands: { handle: () => Promise.resolve() },
      allowedOrigins: ["http://127.0.0.1:30000"],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const sockets: WebSocket[] = [];
    closers.push(async () => {
      for (const socket of sockets) socket.close();
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const current = issueSession({
      enrollment,
      assertionSecret,
      now: clock,
      clientId: "current",
      worldId: "world-one",
      isGm: true,
    });
    const currentSocket = await connect(
      url,
      current.clientId,
      current.browserSessionId,
      current.credential,
    );
    sockets.push(currentSocket);
    assert.equal(gateway.currentGm("world-one")?.isGm, true);
    assert.equal(gateway.currentGm("world-two"), null);

    enrollment.revoke(current.credential);
    assert.equal(gateway.currentGm("world-one"), null);

    const expiring = issueSession({
      enrollment,
      assertionSecret,
      now: clock,
      clientId: "expiring",
      worldId: "world-one",
      isGm: true,
    });
    const expiringSocket = await connect(
      url,
      expiring.clientId,
      expiring.browserSessionId,
      expiring.credential,
    );
    sockets.push(expiringSocket);
    clock = new Date(clock.getTime() + 10 * 60_000 + 1);
    assert.equal(gateway.currentGm("world-one"), null);

    const disconnecting = issueSession({
      enrollment,
      assertionSecret,
      now: clock,
      clientId: "disconnecting",
      worldId: "world-one",
      isGm: true,
    });
    const disconnectingSocket = await connect(
      url,
      disconnecting.clientId,
      disconnecting.browserSessionId,
      disconnecting.credential,
    );
    sockets.push(disconnectingSocket);
    assert.equal(gateway.currentGm("world-one")?.userId, "gm-disconnecting");
    const closed = new Promise<void>((resolve) =>
      disconnectingSocket.once("close", () => resolve()),
    );
    disconnectingSocket.close();
    await closed;
    assert.equal(gateway.currentGm("world-one"), null);
  });

  void it("routes by world and user and revalidates session expiry before commands", async () => {
    let clock = new Date("2026-09-29T00:00:00.000Z");
    const repository = new InMemoryAiDmEnrollmentRepository();
    const assertionSecret = "b".repeat(32);
    const enrollment = new AiDmFoundrySessionService({
      repository,
      moduleVersion: "0.1.0",
      assertionSecret,
      now: () => clock,
    });
    const credentials: Array<{ clientId: string; browserSessionId: string; credential: string }> =
      [];
    for (const [clientId, worldId] of [
      ["client-one", "world-one"],
      ["client-two", "world-two"],
    ] as const) {
      const browserSessionId = `browser_session_${clientId}`;
      const binding = {
        connectionId: `setup-${clientId}`,
        origin: "http://127.0.0.1:30000",
        clientId,
        browserSessionId,
        worldId,
        moduleVersion: "0.1.0",
      };
      const challenge = enrollment.issueChallenge(binding);
      const body = Buffer.from(
        JSON.stringify({
          version: 1,
          jti: randomBytes(16).toString("hex"),
          challengeId: challenge.challengeId,
          challenge: challenge.challenge,
          connectionId: binding.connectionId,
          aiClientId: clientId,
          browserSessionId,
          worldId,
          userId: "same-user",
          lane: "player",
          isGm: false,
          foundrySocketId: `socket-${clientId}`,
          issuedAt: clock.toISOString(),
          expiresAt: new Date(clock.getTime() + 30_000).toISOString(),
        }),
      ).toString("base64url");
      const assertion = `${body}.${createHmac("sha256", assertionSecret).update(body).digest("base64url")}`;
      const accepted = enrollment.exchangeAssertion({ ...binding, assertion });
      credentials.push({ clientId, browserSessionId, credential: accepted.sessionCredential });
    }
    let commandCount = 0;
    const server = createServer();
    const gateway = new AiDmWebSocketGateway(server, {
      enrollment,
      commands: {
        handle: () => {
          commandCount += 1;
          return Promise.resolve();
        },
      },
      allowedOrigins: ["http://127.0.0.1:30000"],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/ws`;
    const first = await connect(
      url,
      credentials[0]!.clientId,
      credentials[0]!.browserSessionId,
      credentials[0]!.credential,
    );
    const second = await connect(
      url,
      credentials[1]!.clientId,
      credentials[1]!.browserSessionId,
      credentials[1]!.credential,
    );
    closers.push(async () => {
      first.close();
      second.close();
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const received = nextMessage(first);
    assert.equal(gateway.sendDelivery(delivery("world-one")), 1);
    assert.equal((await received)["type"], "aiDm.delivery");

    clock = new Date("2026-09-30T01:00:00.000Z");
    const refused = nextMessage(first);
    first.send(
      JSON.stringify({
        type: "aiDm.command",
        payload: {
          type: "aiDm.history.fetch",
          payload: { requestId: "request-1", limit: 10 },
        },
      }),
    );
    assert.equal((await refused)["type"], "aiDm.connection.refused");
    assert.equal(commandCount, 0);
  });
});
