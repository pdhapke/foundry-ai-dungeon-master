import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { InMemoryAiDmEnrollmentRepository } from "./enrollment.js";
import { AiDmFoundrySessionError, AiDmFoundrySessionService } from "./foundry-session.js";

const secret = "b".repeat(32);
const baseTime = new Date("2026-09-29T00:00:00.000Z");

function signed(payload: Record<string, unknown>, signingSecret = secret): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", signingSecret).update(body).digest("base64url")}`;
}

function setup() {
  let clock = baseTime;
  const repository = new InMemoryAiDmEnrollmentRepository();
  const service = new AiDmFoundrySessionService({
    repository,
    moduleVersion: "0.1.0",
    assertionSecret: secret,
    now: () => clock,
  });
  return {
    repository,
    service,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

function exchange(
  service: AiDmFoundrySessionService,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const binding = {
    connectionId: "connection-1",
    origin: "http://127.0.0.1:30000",
    clientId: "client-1",
    browserSessionId: "browser_session_1",
    worldId: "world-1",
    moduleVersion: "0.1.0",
  };
  const challenge = service.issueChallenge(binding);
  const payload = {
    version: 1,
    jti: randomBytes(16).toString("hex"),
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    connectionId: binding.connectionId,
    aiClientId: binding.clientId,
    browserSessionId: binding.browserSessionId,
    worldId: binding.worldId,
    userId: "user-1",
    lane: "player",
    isGm: false,
    foundrySocketId: "socket-1",
    issuedAt: baseTime.toISOString(),
    expiresAt: new Date(baseTime.getTime() + 30_000).toISOString(),
    ...overrides,
  };
  return {
    binding,
    challenge,
    payload,
    run: (assertion = signed(payload)) =>
      service.exchangeAssertion({
        assertion,
        connectionId: binding.connectionId,
        origin: binding.origin,
        clientId: binding.clientId,
        browserSessionId: binding.browserSessionId,
        moduleVersion: binding.moduleVersion,
      }),
  };
}

void describe("authoritative Foundry local sessions", () => {
  void it("uses a random 256-bit single-use challenge and authoritative GM role", () => {
    const { service } = setup();
    const first = exchange(service, { lane: "gm", isGm: true, userId: "gm-1" });
    const second = service.issueChallenge({ ...first.binding, connectionId: "connection-2" });
    assert.equal(Buffer.from(first.challenge.challenge, "base64url").length, 32);
    assert.notEqual(first.challenge.challenge, second.challenge);
    const result = first.run();
    assert.equal(result.identity.isGm, true);
    assert.equal(result.identity.userId, "gm-1");
    assert.throws(
      first.run,
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "CHALLENGE_INVALID",
    );
  });

  void it("rejects browser role or user spoofing, invalid signatures, and GM/lane inconsistency", () => {
    const { service } = setup();
    const invalidSignature = exchange(service, { lane: "gm", isGm: true });
    assert.throws(
      () => invalidSignature.run(signed(invalidSignature.payload, "x".repeat(32))),
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "ASSERTION_INVALID",
    );
    const userSpoof = exchange(service);
    const valid = signed(userSpoof.payload);
    const [body, signature] = valid.split(".") as [string, string];
    const changed = {
      ...(JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>),
      userId: "attacker-user",
    };
    const tampered = `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
    assert.throws(
      () => userSpoof.run(tampered),
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "ASSERTION_INVALID",
    );
    const inconsistent = exchange(service, { lane: "player", isGm: true });
    assert.throws(
      inconsistent.run,
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "ASSERTION_IDENTITY_MISMATCH",
    );
  });

  void it("atomically allows only one winner when the same challenge is raced", async () => {
    const { service } = setup();
    const attempt = exchange(service);
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => attempt.run()),
      Promise.resolve().then(() => attempt.run()),
    ]);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  });

  void it("rejects world, user-client, browser, connection, and challenge substitution", () => {
    for (const changed of [
      { worldId: "world-2" },
      { aiClientId: "client-2" },
      { browserSessionId: "browser_session_2" },
      { connectionId: "connection-2" },
      { challenge: randomBytes(32).toString("base64url") },
    ]) {
      const { service } = setup();
      const attempt = exchange(service, changed);
      assert.throws(
        attempt.run,
        (error: unknown) =>
          error instanceof AiDmFoundrySessionError && error.code === "ASSERTION_IDENTITY_MISMATCH",
      );
    }
  });

  void it("rejects expired challenges and assertions", () => {
    const challengeClock = setup();
    const staleChallenge = exchange(challengeClock.service);
    challengeClock.advance(15_001);
    assert.throws(
      staleChallenge.run,
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "CHALLENGE_EXPIRED",
    );

    const assertionClock = setup();
    const staleAssertion = exchange(assertionClock.service, {
      expiresAt: new Date(baseTime.getTime() + 1_000).toISOString(),
    });
    assertionClock.advance(1_001);
    assert.throws(
      staleAssertion.run,
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "ASSERTION_EXPIRED",
    );
  });

  void it("binds sessions, stores only hashes, expires, and revokes", () => {
    const context = setup();
    const attempt = exchange(context.service);
    const result = attempt.run();
    assert.equal(context.repository.findSession(result.sessionCredential), null);
    const authenticated = context.service.authenticate({
      sessionCredential: result.sessionCredential,
      clientId: attempt.binding.clientId,
      browserSessionId: attempt.binding.browserSessionId,
      moduleVersion: attempt.binding.moduleVersion,
    });
    assert.equal(authenticated.identity.worldId, "world-1");
    assert.equal(context.service.validateProof(authenticated).identity.userId, "user-1");
    assert.throws(
      () =>
        context.service.validateProof({
          ...authenticated,
          generation: authenticated.generation + 1,
        }),
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "SESSION_IDENTITY_MISMATCH",
    );
    assert.throws(
      () =>
        context.service.authenticate({
          sessionCredential: result.sessionCredential,
          clientId: attempt.binding.clientId,
          browserSessionId: "browser_session_2",
          moduleVersion: attempt.binding.moduleVersion,
        }),
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "SESSION_IDENTITY_MISMATCH",
    );
    context.service.revoke(result.sessionCredential);
    assert.throws(
      () => context.service.validateProof(authenticated),
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "SESSION_INVALID",
    );
    assert.throws(
      () =>
        context.service.authenticate({
          sessionCredential: result.sessionCredential,
          clientId: attempt.binding.clientId,
          browserSessionId: attempt.binding.browserSessionId,
          moduleVersion: attempt.binding.moduleVersion,
        }),
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "SESSION_INVALID",
    );
  });

  void it("rejects expired and legacy auth-version sessions", () => {
    const context = setup();
    const attempt = exchange(context.service);
    const result = attempt.run();
    context.advance(10 * 60_000 + 1);
    assert.throws(
      () =>
        context.service.authenticate({
          sessionCredential: result.sessionCredential,
          clientId: attempt.binding.clientId,
          browserSessionId: attempt.binding.browserSessionId,
          moduleVersion: attempt.binding.moduleVersion,
        }),
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "SESSION_EXPIRED",
    );
    context.repository.saveSession({
      credentialHash: createHash("sha256").update("legacy-session-credential-value").digest("hex"),
      identity: {
        clientId: "client-1",
        userId: "player-1",
        worldId: "world-1",
        lane: "player",
        isGm: false,
      },
      clientId: "client-1",
      moduleVersion: "0.1.0",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
    });
    assert.throws(
      () =>
        context.service.authenticate({
          sessionCredential: "legacy-session-credential-value",
          clientId: "client-1",
          browserSessionId: "browser_session_1",
          moduleVersion: "0.1.0",
        }),
      (error: unknown) =>
        error instanceof AiDmFoundrySessionError && error.code === "SESSION_INVALID",
    );
  });
});
