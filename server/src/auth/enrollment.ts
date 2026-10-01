import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { AiDmAuthenticatedIdentity, AiDmClientLane } from "@foundry-ai-dungeon-master/shared";

/** @deprecated Compatibility shape for existing rows/tests; not exposed by transport v2. */
interface AiDmEnrollmentRedeem {
  protocolVersion: number;
  clientId: string;
  oneTimeCode: string;
  claimedUserId: string;
  claimedWorldId: string;
  moduleVersion: string;
}

export interface EnrollmentRecord {
  codeHash: string;
  userId: string;
  worldId: string;
  lane: AiDmClientLane;
  expectedClientId: string | null;
  expiresAt: string;
  consumedAt: string | null;
}

export interface SessionRecord {
  credentialHash: string;
  identity: AiDmAuthenticatedIdentity;
  clientId: string;
  /** Present only on authoritative Foundry sessions. Legacy rows intentionally fail v2 auth. */
  browserSessionId?: string;
  moduleVersion: string;
  authVersion?: number;
  generation?: number;
  issuedAt?: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AiDmEnrollmentRepository {
  saveEnrollment(record: EnrollmentRecord): void;
  findEnrollment(codeHash: string): EnrollmentRecord | null;
  consumeEnrollment(codeHash: string, consumedAt: string): boolean;
  saveSession(record: SessionRecord): void;
  findSession(credentialHash: string): SessionRecord | null;
  revokeSession(credentialHash: string, revokedAt: string): void;
}

export interface AiDmIdentityVerifier {
  verify(input: {
    userId: string;
    worldId: string;
    lane: AiDmClientLane;
  }): Promise<{ verified: true; isGm: boolean }>;
}

export class InMemoryAiDmEnrollmentRepository implements AiDmEnrollmentRepository {
  readonly #enrollments = new Map<string, EnrollmentRecord>();
  readonly #sessions = new Map<string, SessionRecord>();

  saveEnrollment(record: EnrollmentRecord): void {
    this.#enrollments.set(record.codeHash, structuredClone(record));
  }
  findEnrollment(codeHash: string): EnrollmentRecord | null {
    return structuredClone(this.#enrollments.get(codeHash) ?? null);
  }
  consumeEnrollment(codeHash: string, consumedAt: string): boolean {
    const record = this.#enrollments.get(codeHash);
    if (!record || record.consumedAt) return false;
    record.consumedAt = consumedAt;
    return true;
  }
  saveSession(record: SessionRecord): void {
    this.#sessions.set(record.credentialHash, structuredClone(record));
  }
  findSession(credentialHash: string): SessionRecord | null {
    return structuredClone(this.#sessions.get(credentialHash) ?? null);
  }
  revokeSession(credentialHash: string, revokedAt: string): void {
    const record = this.#sessions.get(credentialHash);
    if (record) record.revokedAt = revokedAt;
  }
}

export class AiDmEnrollmentError extends Error {
  constructor(
    readonly code:
      | "ENROLLMENT_INVALID"
      | "ENROLLMENT_EXPIRED"
      | "ENROLLMENT_IDENTITY_MISMATCH"
      | "SESSION_INVALID"
      | "SESSION_EXPIRED"
      | "SESSION_IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "AiDmEnrollmentError";
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AiDmEnrollmentService {
  readonly #repository: AiDmEnrollmentRepository;
  readonly #verifier: AiDmIdentityVerifier;
  readonly #moduleVersion: string;
  readonly #now: () => Date;

  constructor(options: {
    repository: AiDmEnrollmentRepository;
    verifier: AiDmIdentityVerifier;
    moduleVersion: string;
    now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#verifier = options.verifier;
    this.#moduleVersion = options.moduleVersion;
    this.#now = options.now ?? (() => new Date());
  }

  async issue(input: {
    userId: string;
    worldId: string;
    lane: AiDmClientLane;
    expectedClientId?: string;
    ttlMs?: number;
  }): Promise<{ oneTimeCode: string; expiresAt: string }> {
    await this.#verifier.verify(input);
    const oneTimeCode = randomBytes(18).toString("base64url");
    const expiresAt = new Date(this.#now().getTime() + (input.ttlMs ?? 5 * 60_000)).toISOString();
    this.#repository.saveEnrollment({
      codeHash: sha256(oneTimeCode),
      userId: input.userId,
      worldId: input.worldId,
      lane: input.lane,
      expectedClientId: input.expectedClientId ?? null,
      expiresAt,
      consumedAt: null,
    });
    return { oneTimeCode, expiresAt };
  }

  async redeem(request: AiDmEnrollmentRedeem): Promise<{
    sessionCredential: string;
    expiresAt: string;
    identity: AiDmAuthenticatedIdentity;
  }> {
    const now = this.#now();
    const codeHash = sha256(request.oneTimeCode);
    const enrollment = this.#repository.findEnrollment(codeHash);
    if (!enrollment || enrollment.consumedAt) {
      throw new AiDmEnrollmentError("ENROLLMENT_INVALID", "Enrollment is invalid or already used.");
    }
    if (Date.parse(enrollment.expiresAt) <= now.getTime()) {
      throw new AiDmEnrollmentError("ENROLLMENT_EXPIRED", "Enrollment has expired.");
    }
    if (
      !equalText(enrollment.userId, request.claimedUserId) ||
      !equalText(enrollment.worldId, request.claimedWorldId) ||
      (enrollment.expectedClientId !== null &&
        !equalText(enrollment.expectedClientId, request.clientId)) ||
      request.moduleVersion !== this.#moduleVersion
    ) {
      this.#repository.consumeEnrollment(codeHash, now.toISOString());
      throw new AiDmEnrollmentError(
        "ENROLLMENT_IDENTITY_MISMATCH",
        "Enrollment identity does not match the verified binding.",
      );
    }
    const verified = await this.#verifier.verify({
      userId: enrollment.userId,
      worldId: enrollment.worldId,
      lane: enrollment.lane,
    });
    if (!this.#repository.consumeEnrollment(codeHash, now.toISOString())) {
      throw new AiDmEnrollmentError("ENROLLMENT_INVALID", "Enrollment was already used.");
    }
    const sessionCredential = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const identity: AiDmAuthenticatedIdentity = {
      clientId: request.clientId,
      userId: enrollment.userId,
      worldId: enrollment.worldId,
      lane: enrollment.lane,
      isGm: verified.isGm,
    };
    this.#repository.saveSession({
      credentialHash: sha256(sessionCredential),
      identity,
      clientId: request.clientId,
      moduleVersion: request.moduleVersion,
      expiresAt,
      revokedAt: null,
    });
    return { sessionCredential, expiresAt, identity };
  }

  authenticate(input: { sessionCredential: string; clientId: string; moduleVersion: string }): {
    identity: AiDmAuthenticatedIdentity;
    expiresAt: string;
  } {
    const record = this.#repository.findSession(sha256(input.sessionCredential));
    if (!record || record.revokedAt) {
      throw new AiDmEnrollmentError("SESSION_INVALID", "Session is invalid.");
    }
    if (Date.parse(record.expiresAt) <= this.#now().getTime()) {
      throw new AiDmEnrollmentError("SESSION_EXPIRED", "Session has expired.");
    }
    if (record.clientId !== input.clientId || record.moduleVersion !== input.moduleVersion) {
      throw new AiDmEnrollmentError("SESSION_IDENTITY_MISMATCH", "Session binding does not match.");
    }
    return { identity: record.identity, expiresAt: record.expiresAt };
  }
}
