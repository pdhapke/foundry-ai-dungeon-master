import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { AiDmAuthenticatedIdentity, AiDmClientLane } from "@foundry-ai-dungeon-master/shared";

import type { AiDmEnrollmentRepository } from "./enrollment.js";

interface ChallengeRecord {
  challengeHash: string;
  connectionId: string;
  origin: string;
  clientId: string;
  browserSessionId: string;
  worldId: string;
  moduleVersion: string;
  expiresAt: string;
  consumed: boolean;
}

interface FoundryAssertion {
  version: 1;
  jti: string;
  challengeId: string;
  challenge: string;
  connectionId: string;
  aiClientId: string;
  browserSessionId: string;
  worldId: string;
  userId: string;
  lane: AiDmClientLane;
  isGm: boolean;
  foundrySocketId: string;
  issuedAt: string;
  expiresAt: string;
}

/** Opaque, server-only proof that can be revalidated against durable local-session state. */
export interface AiDmLocalSessionProof {
  sessionHash: string;
  generation: number;
  identity: AiDmAuthenticatedIdentity;
  clientId: string;
  browserSessionId: string;
  moduleVersion: string;
  expiresAt: string;
}

export class AiDmFoundrySessionError extends Error {
  constructor(
    readonly code:
      | "ASSERTION_INVALID"
      | "ASSERTION_EXPIRED"
      | "ASSERTION_IDENTITY_MISMATCH"
      | "CHALLENGE_INVALID"
      | "CHALLENGE_EXPIRED"
      | "SESSION_INVALID"
      | "SESSION_EXPIRED"
      | "SESSION_IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "AiDmFoundrySessionError";
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function equalText(left: string, right: string): boolean {
  return equalBytes(Buffer.from(left), Buffer.from(right));
}

function nonEmpty(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function parseAssertion(value: string, secret: string): FoundryAssertion {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AiDmFoundrySessionError("ASSERTION_INVALID", "Foundry assertion is invalid.");
  }
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  let actual: Buffer;
  let parsed: unknown;
  try {
    actual = Buffer.from(parts[1], "base64url");
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new AiDmFoundrySessionError("ASSERTION_INVALID", "Foundry assertion is invalid.");
  }
  if (!equalBytes(actual, expected) || !parsed || typeof parsed !== "object") {
    throw new AiDmFoundrySessionError("ASSERTION_INVALID", "Foundry assertion is invalid.");
  }
  const claim = parsed as Record<string, unknown>;
  const lane = claim["lane"];
  if (
    claim["version"] !== 1 ||
    !nonEmpty(claim["jti"], 160) ||
    !nonEmpty(claim["challengeId"], 160) ||
    !nonEmpty(claim["challenge"], 160) ||
    !nonEmpty(claim["connectionId"], 160) ||
    !nonEmpty(claim["aiClientId"], 160) ||
    !nonEmpty(claim["browserSessionId"], 160) ||
    !nonEmpty(claim["worldId"], 160) ||
    !nonEmpty(claim["userId"], 160) ||
    (lane !== "gm" && lane !== "player" && lane !== "tv") ||
    typeof claim["isGm"] !== "boolean" ||
    !nonEmpty(claim["foundrySocketId"], 160) ||
    !nonEmpty(claim["issuedAt"], 64) ||
    !nonEmpty(claim["expiresAt"], 64)
  ) {
    throw new AiDmFoundrySessionError("ASSERTION_INVALID", "Foundry assertion claims are invalid.");
  }
  return claim as unknown as FoundryAssertion;
}

/** Issues short-lived, hash-only local sessions from authoritative Foundry broker assertions. */
export class AiDmFoundrySessionService {
  readonly #challenges = new Map<string, ChallengeRecord>();
  readonly #usedAssertionIds = new Map<string, number>();
  readonly #now: () => Date;
  readonly #challengeTtlMs: number;
  readonly #sessionTtlMs: number;

  constructor(
    private readonly options: {
      repository: AiDmEnrollmentRepository;
      moduleVersion: string;
      assertionSecret: string;
      now?: () => Date;
      challengeTtlMs?: number;
      sessionTtlMs?: number;
      authVersion?: number;
    },
  ) {
    if (Buffer.byteLength(options.assertionSecret) < 32) {
      throw new Error("Foundry broker assertion secret must contain at least 256 bits.");
    }
    this.#now = options.now ?? (() => new Date());
    this.#challengeTtlMs = options.challengeTtlMs ?? 15_000;
    this.#sessionTtlMs = options.sessionTtlMs ?? 10 * 60_000;
    if (this.#challengeTtlMs <= 0 || this.#challengeTtlMs > 30_000) {
      throw new Error("Challenge lifetime must be at most 30 seconds.");
    }
    if (this.#sessionTtlMs < 5 * 60_000 || this.#sessionTtlMs > 15 * 60_000) {
      throw new Error("Local session lifetime must be between 5 and 15 minutes.");
    }
  }

  issueChallenge(input: {
    connectionId: string;
    origin: string;
    clientId: string;
    browserSessionId: string;
    worldId: string;
    moduleVersion: string;
  }): { challengeId: string; challenge: string; connectionId: string; expiresAt: string } {
    if (input.moduleVersion !== this.options.moduleVersion) {
      throw new AiDmFoundrySessionError("CHALLENGE_INVALID", "Module version does not match.");
    }
    const nowMs = this.#now().getTime();
    for (const [id, challenge] of this.#challenges) {
      if (Date.parse(challenge.expiresAt) <= nowMs) this.#challenges.delete(id);
    }
    for (const [id, expiresAt] of this.#usedAssertionIds) {
      if (expiresAt <= nowMs) this.#usedAssertionIds.delete(id);
    }
    const challengeId = randomUUID();
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(nowMs + this.#challengeTtlMs).toISOString();
    this.#challenges.set(challengeId, {
      challengeHash: sha256(challenge),
      connectionId: input.connectionId,
      origin: input.origin,
      clientId: input.clientId,
      browserSessionId: input.browserSessionId,
      worldId: input.worldId,
      moduleVersion: input.moduleVersion,
      expiresAt,
      consumed: false,
    });
    return { challengeId, challenge, connectionId: input.connectionId, expiresAt };
  }

  exchangeAssertion(input: {
    assertion: string;
    connectionId: string;
    origin: string;
    clientId: string;
    browserSessionId: string;
    moduleVersion: string;
  }): { sessionCredential: string; expiresAt: string; identity: AiDmAuthenticatedIdentity } {
    const claim = parseAssertion(input.assertion, this.options.assertionSecret);
    const now = this.#now();
    const nowMs = now.getTime();
    const issuedAt = Date.parse(claim.issuedAt);
    const assertionExpiresAt = Date.parse(claim.expiresAt);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(assertionExpiresAt) ||
      issuedAt > nowMs + 5_000 ||
      assertionExpiresAt <= nowMs ||
      assertionExpiresAt - issuedAt > 30_000
    ) {
      throw new AiDmFoundrySessionError("ASSERTION_EXPIRED", "Foundry assertion has expired.");
    }
    const challenge = this.#challenges.get(claim.challengeId);
    if (!challenge || challenge.consumed || this.#usedAssertionIds.has(claim.jti)) {
      throw new AiDmFoundrySessionError(
        "CHALLENGE_INVALID",
        "Challenge is invalid or already used.",
      );
    }
    // Atomic in the JS event loop and performed before binding checks to defeat races and probing.
    challenge.consumed = true;
    this.#usedAssertionIds.set(claim.jti, assertionExpiresAt);
    if (Date.parse(challenge.expiresAt) <= nowMs) {
      throw new AiDmFoundrySessionError("CHALLENGE_EXPIRED", "Challenge has expired.");
    }
    if (
      !equalText(challenge.challengeHash, sha256(claim.challenge)) ||
      !equalText(challenge.connectionId, input.connectionId) ||
      !equalText(challenge.connectionId, claim.connectionId) ||
      !equalText(challenge.origin, input.origin) ||
      !equalText(challenge.clientId, input.clientId) ||
      !equalText(challenge.clientId, claim.aiClientId) ||
      !equalText(challenge.browserSessionId, input.browserSessionId) ||
      !equalText(challenge.browserSessionId, claim.browserSessionId) ||
      !equalText(challenge.worldId, claim.worldId) ||
      challenge.moduleVersion !== input.moduleVersion ||
      input.moduleVersion !== this.options.moduleVersion ||
      (claim.lane === "gm") !== claim.isGm
    ) {
      throw new AiDmFoundrySessionError(
        "ASSERTION_IDENTITY_MISMATCH",
        "Foundry assertion does not match the connection binding.",
      );
    }
    const sessionCredential = randomBytes(32).toString("base64url");
    const expiresAt = new Date(nowMs + this.#sessionTtlMs).toISOString();
    const identity: AiDmAuthenticatedIdentity = {
      clientId: input.clientId,
      userId: claim.userId,
      worldId: claim.worldId,
      lane: claim.lane,
      isGm: claim.isGm,
    };
    this.options.repository.saveSession({
      credentialHash: sha256(sessionCredential),
      identity,
      clientId: input.clientId,
      browserSessionId: input.browserSessionId,
      moduleVersion: input.moduleVersion,
      authVersion: this.options.authVersion ?? 2,
      generation: 1,
      issuedAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
    });
    this.#challenges.delete(claim.challengeId);
    return { sessionCredential, expiresAt, identity };
  }

  authenticate(input: {
    sessionCredential: string;
    clientId: string;
    browserSessionId: string;
    moduleVersion: string;
  }): AiDmLocalSessionProof {
    const sessionHash = sha256(input.sessionCredential);
    const record = this.options.repository.findSession(sessionHash);
    if (!record || record.revokedAt || record.authVersion !== (this.options.authVersion ?? 2)) {
      throw new AiDmFoundrySessionError("SESSION_INVALID", "Session is invalid.");
    }
    if (Date.parse(record.expiresAt) <= this.#now().getTime()) {
      throw new AiDmFoundrySessionError("SESSION_EXPIRED", "Session has expired.");
    }
    if (
      !record.browserSessionId ||
      !equalText(record.clientId, input.clientId) ||
      !equalText(record.browserSessionId, input.browserSessionId) ||
      record.moduleVersion !== input.moduleVersion
    ) {
      throw new AiDmFoundrySessionError(
        "SESSION_IDENTITY_MISMATCH",
        "Session binding does not match.",
      );
    }
    return {
      sessionHash,
      identity: record.identity,
      clientId: record.clientId,
      browserSessionId: record.browserSessionId,
      moduleVersion: record.moduleVersion,
      expiresAt: record.expiresAt,
      generation: record.generation ?? 0,
    };
  }

  validateProof(proof: AiDmLocalSessionProof): AiDmLocalSessionProof {
    const record = this.options.repository.findSession(proof.sessionHash);
    if (!record || record.revokedAt || record.authVersion !== (this.options.authVersion ?? 2)) {
      throw new AiDmFoundrySessionError("SESSION_INVALID", "Session is invalid.");
    }
    if (Date.parse(record.expiresAt) <= this.#now().getTime()) {
      throw new AiDmFoundrySessionError("SESSION_EXPIRED", "Session has expired.");
    }
    if (
      !record.browserSessionId ||
      record.generation !== proof.generation ||
      !equalText(record.clientId, proof.clientId) ||
      !equalText(record.browserSessionId, proof.browserSessionId) ||
      record.moduleVersion !== proof.moduleVersion ||
      record.expiresAt !== proof.expiresAt ||
      record.identity.clientId !== proof.identity.clientId ||
      record.identity.userId !== proof.identity.userId ||
      record.identity.worldId !== proof.identity.worldId ||
      record.identity.lane !== proof.identity.lane ||
      record.identity.isGm !== proof.identity.isGm
    ) {
      throw new AiDmFoundrySessionError("SESSION_IDENTITY_MISMATCH", "Session proof is stale.");
    }
    return structuredClone(proof);
  }

  revoke(sessionCredential: string): void {
    this.options.repository.revokeSession(sha256(sessionCredential), this.#now().toISOString());
  }
}
