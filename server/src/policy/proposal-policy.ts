import { createHash } from "node:crypto";

import type {
  AiDmAccessScope,
  AiDmActionProposal,
  AiDmApprovalPolicy,
  AiDmCommitGrant,
  AiDmEffectiveAudience,
  AiDmExpectedRevision,
  AiDmRunPrincipal,
} from "@foundry-ai-dungeon-master/shared";

import type {
  AiDmCommitAuthorizationInput,
  AiDmCommitAuthorizationResult,
  AiDmModelProposalInput,
  AiDmPolicyCatalog,
  AiDmPolicyOutcome,
  AiDmPolicyToolRecord,
} from "./types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function requiredDecision(records: AiDmPolicyToolRecord[]): AiDmApprovalPolicy {
  if (records.some(({ approvalPolicy }) => approvalPolicy === "always-refuse")) {
    return "always-refuse";
  }
  if (
    records.some(
      ({ approvalPolicy, risk }) => approvalPolicy === "gm-approval" || risk === "destructive",
    )
  ) {
    return "gm-approval";
  }
  if (records.some(({ approvalPolicy }) => approvalPolicy === "player-confirmation")) {
    return "player-confirmation";
  }
  return "none";
}

function scopeForDecision(
  decision: AiDmApprovalPolicy,
  principal: AiDmRunPrincipal,
): AiDmAccessScope {
  return decision === "player-confirmation"
    ? { kind: "users", userIds: [principal.userId] }
    : { kind: "gm" };
}

export function evaluateProposal(
  input: AiDmModelProposalInput,
  principal: AiDmRunPrincipal,
  catalog: AiDmPolicyCatalog,
  now: string,
): AiDmPolicyOutcome {
  if (input.operations.length === 0 || input.operations.length > 12) {
    return {
      decision: "refuse",
      code: "INVALID_OPERATION_COUNT",
      message: "Proposal operation count is invalid.",
    };
  }
  const records: AiDmPolicyToolRecord[] = [];
  for (const operation of input.operations) {
    const record = catalog.get(operation.toolId);
    if (!record) {
      return {
        decision: "refuse",
        code: "TOOL_UNKNOWN",
        message: "A proposed capability is not trusted.",
      };
    }
    if (!record.available) {
      return {
        decision: "refuse",
        code: "TOOL_UNAVAILABLE",
        message: "A proposed capability is unavailable.",
      };
    }
    if (record.effects.some((effect) => effect === "commit" || effect === "propose")) {
      if (!record.supportsExpectedRevision || !record.supportsIdempotency) {
        return {
          decision: "refuse",
          code: "UNSAFE_COMMIT_CONTRACT",
          message: "A proposed capability lacks revision or idempotency guarantees.",
        };
      }
      if (operation.expectedRevisions.length === 0) {
        return {
          decision: "refuse",
          code: "EXPECTED_REVISION_REQUIRED",
          message: "A consequential operation requires an expected revision.",
        };
      }
    }
    records.push(record);
  }

  const approvalPolicy = requiredDecision(records);
  if (approvalPolicy === "always-refuse") {
    return { decision: "refuse", code: "POLICY_REFUSED", message: "Policy refuses this proposal." };
  }

  const proposalBody = {
    proposalId: input.proposalId,
    runId: input.runId,
    causeEventId: input.causeEventId,
    summary: input.summary,
    expiresAt: input.expiresAt,
    operations: input.operations,
    catalogRevision: catalog.catalogRevision,
    policyRevision: catalog.policyRevision,
  };
  const proposalRevision = digest(proposalBody);
  const effectiveAudience: AiDmEffectiveAudience = {
    scope: { kind: "users", userIds: [principal.userId] },
    transcript: true,
    mirrorToFoundryChat: false,
  };
  const status =
    approvalPolicy === "none"
      ? "approved"
      : approvalPolicy === "player-confirmation"
        ? "waiting-for-player"
        : "waiting-for-gm";
  const proposal: AiDmActionProposal = {
    proposalId: input.proposalId,
    runId: input.runId,
    causeEventId: input.causeEventId,
    createdAt: now,
    expiresAt: input.expiresAt,
    status,
    proposalRevision,
    policyRevision: catalog.policyRevision,
    catalogRevision: catalog.catalogRevision,
    summary: input.summary,
    effectiveAudience,
    approvalAuthority: scopeForDecision(approvalPolicy, principal),
    operations: input.operations,
    stateDeltas: [],
  };
  return {
    decision:
      approvalPolicy === "none"
        ? "auto-commit"
        : approvalPolicy === "player-confirmation"
          ? "require-player"
          : "require-gm",
    proposal,
  };
}

function revisionKey(revision: AiDmExpectedRevision): string {
  return `${revision.provider}:${revision.resourceKind}:${revision.resourceId}`;
}

function scopeAllows(scope: AiDmAccessScope, principal: AiDmRunPrincipal): boolean {
  if (scope.kind === "public") return true;
  if (scope.kind === "gm") return principal.isGm;
  return scope.userIds.includes(principal.userId);
}

export function authorizeCommit(
  input: AiDmCommitAuthorizationInput,
  catalog: AiDmPolicyCatalog,
): AiDmCommitAuthorizationResult {
  if (Date.parse(input.now) >= Date.parse(input.proposal.expiresAt)) {
    return { allowed: false, code: "PROPOSAL_EXPIRED", message: "The proposal has expired." };
  }
  if (
    input.proposal.catalogRevision !== catalog.catalogRevision ||
    input.proposal.policyRevision !== catalog.policyRevision
  ) {
    return { allowed: false, code: "POLICY_STALE", message: "Catalog or policy changed." };
  }
  if (input.proposal.status !== "approved") {
    if (!input.approval || input.approval.decision !== "approve") {
      return { allowed: false, code: "APPROVAL_REQUIRED", message: "Required approval is absent." };
    }
    if (
      input.approval.proposalId !== input.proposal.proposalId ||
      input.approval.proposalRevision !== input.proposal.proposalRevision ||
      !scopeAllows(
        input.proposal.approvalAuthority,
        input.approval.authenticatedIdentity as AiDmRunPrincipal,
      )
    ) {
      return {
        allowed: false,
        code: "APPROVAL_INVALID",
        message: "Approval authority or revision is invalid.",
      };
    }
  }

  const current = new Map(
    input.currentRevisions.map((revision) => [revisionKey(revision), revision.revision]),
  );
  for (const operation of input.proposal.operations) {
    for (const expected of operation.expectedRevisions) {
      if (current.get(revisionKey(expected)) !== expected.revision) {
        return {
          allowed: false,
          code: "REVISION_CONFLICT",
          message: "A protected resource changed.",
        };
      }
    }
  }

  const operations = input.proposal.operations.map((operation) => {
    const record = catalog.get(operation.toolId);
    if (!record) throw new Error("Catalog changed after revision validation.");
    return {
      operationId: operation.operationId,
      toolId: operation.toolId,
      toolRevision: record.revision,
      schemaDigest: record.schemaDigest,
      argumentsDigest: digest(operation.arguments),
      expectedRevisions: operation.expectedRevisions,
      idempotencyKey: `ai-dm:${input.proposal.proposalId}:${operation.operationId}`,
      maximumCalls: 1,
    };
  });
  const grantBody = {
    proposalId: input.proposal.proposalId,
    proposalRevision: input.proposal.proposalRevision,
    policyRevision: catalog.policyRevision,
    catalogRevision: catalog.catalogRevision,
    operations,
  };
  const grant: AiDmCommitGrant = {
    commitGrantId: `commit-${digest(grantBody).slice(0, 32)}`,
    ...grantBody,
    issuedAt: input.now,
    expiresAt: input.proposal.expiresAt,
  };
  return { allowed: true, grant };
}
