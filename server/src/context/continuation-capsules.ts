import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  AiDmAccessScope,
  AiDmContinuationCapsule,
  AiDmContextDependency,
  AiDmVisibility,
} from "@foundry-ai-dungeon-master/shared";

import { hashText, stableJson } from "./hash.js";
import { ContextError, type ScopeExpectation } from "./types.js";

export interface MintCapsuleInput {
  capsuleId: string;
  threadId: string;
  worldId: string;
  principalUserId: string;
  disclosureScope: AiDmAccessScope;
  priorRunId: string;
  priorEventId: string;
  createdAt: string;
  expiresAt: string;
  visibility: AiDmVisibility;
  summary: string;
  unresolvedReferences: string[];
  sourceNodeRevisions: AiDmContextDependency[];
}

type UnsignedCapsule = Omit<AiDmContinuationCapsule, "checksum" | "signature">;

function normalizedScope(scope: AiDmAccessScope): AiDmAccessScope {
  return scope.kind === "users"
    ? { kind: "users", userIds: [...new Set(scope.userIds)].sort() }
    : { ...scope };
}

function unsigned(capsule: AiDmContinuationCapsule | MintCapsuleInput): UnsignedCapsule {
  const {
    capsuleId,
    threadId,
    worldId,
    principalUserId,
    disclosureScope,
    priorRunId,
    priorEventId,
    createdAt,
    expiresAt,
    visibility,
    summary,
    unresolvedReferences,
    sourceNodeRevisions,
  } = capsule;
  return {
    capsuleId,
    threadId,
    worldId,
    principalUserId,
    disclosureScope: normalizedScope(disclosureScope),
    priorRunId,
    priorEventId,
    createdAt,
    expiresAt,
    visibility,
    summary,
    unresolvedReferences: [...unresolvedReferences],
    sourceNodeRevisions: structuredClone(sourceNodeRevisions),
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function containsProviderResponseId(value: string): boolean {
  return /\b(?:resp|response)_[A-Za-z0-9_-]{6,}\b/i.test(value);
}

export class ContinuationCapsuleSigner {
  private readonly key: Buffer;

  constructor(key: Uint8Array | string) {
    this.key = Buffer.from(key);
    if (this.key.byteLength < 32) throw new Error("Continuation capsule signing key is too short.");
  }

  mint(input: MintCapsuleInput): AiDmContinuationCapsule {
    this.assertBounds(input);
    const payload = unsigned(input);
    const checksum = hashText(stableJson(payload));
    const signature = this.sign(payload, checksum);
    return { ...payload, checksum, signature };
  }

  validate(
    capsule: AiDmContinuationCapsule,
    expectation: ScopeExpectation,
    currentRevision: (nodeId: string) => string | undefined,
  ): AiDmContinuationCapsule {
    this.assertBounds(capsule);
    const payload = unsigned(capsule);
    const expectedChecksum = hashText(stableJson(payload));
    const expectedSignature = this.sign(payload, expectedChecksum);
    if (
      !safeEqual(capsule.checksum, expectedChecksum) ||
      !safeEqual(capsule.signature, expectedSignature)
    ) {
      throw new ContextError(
        "CAPSULE_STALE",
        "The continuation capsule failed integrity validation.",
      );
    }
    if (
      capsule.worldId !== expectation.worldId ||
      capsule.threadId !== expectation.threadId ||
      capsule.principalUserId !== expectation.principalUserId ||
      stableJson(normalizedScope(capsule.disclosureScope)) !==
        stableJson(normalizedScope(expectation.disclosureScope))
    ) {
      throw new ContextError(
        "CAPSULE_STALE",
        "The continuation capsule binding does not match this run.",
      );
    }
    if (!expectation.isGm && (capsule.visibility === "gm" || capsule.visibility === "secret")) {
      throw new ContextError("CAPSULE_STALE", "The continuation capsule would widen visibility.");
    }
    const createdAt = Date.parse(capsule.createdAt);
    const expiresAt = Date.parse(capsule.expiresAt);
    const now = expectation.now.getTime();
    if (
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      createdAt > now ||
      expiresAt <= now
    ) {
      throw new ContextError(
        "CAPSULE_STALE",
        "The continuation capsule is expired or has invalid time bounds.",
      );
    }
    for (const dependency of capsule.sourceNodeRevisions) {
      if (currentRevision(dependency.nodeId) !== dependency.revision) {
        throw new ContextError(
          "CAPSULE_STALE",
          `Capsule dependency ${dependency.nodeId} is stale.`,
        );
      }
    }
    return structuredClone(capsule);
  }

  private sign(payload: UnsignedCapsule, checksum: string): string {
    return createHmac("sha256", this.key).update(stableJson({ payload, checksum })).digest("hex");
  }

  private assertBounds(capsule: MintCapsuleInput | AiDmContinuationCapsule): void {
    const createdAt = Date.parse(capsule.createdAt);
    const expiresAt = Date.parse(capsule.expiresAt);
    if (
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= createdAt ||
      expiresAt - createdAt > 7 * 24 * 60 * 60 * 1_000 ||
      capsule.summary.length > 4_096 ||
      capsule.unresolvedReferences.length > 32 ||
      capsule.sourceNodeRevisions.length > 32 ||
      capsule.unresolvedReferences.some((value) => value.length > 512) ||
      containsProviderResponseId(capsule.summary) ||
      capsule.unresolvedReferences.some(containsProviderResponseId)
    ) {
      throw new ContextError("CAPSULE_STALE", "The continuation capsule exceeds safe bounds.");
    }
    const dependencyKeys = capsule.sourceNodeRevisions.map(
      ({ nodeId, revision }) => `${nodeId}\0${revision}`,
    );
    if (new Set(dependencyKeys).size !== dependencyKeys.length) {
      throw new ContextError("CAPSULE_STALE", "The continuation capsule repeats dependencies.");
    }
  }
}
