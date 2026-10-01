import type {
  AiDmAccessScope,
  AiDmActionProposal,
  AiDmApprovalDecision,
  AiDmApprovalPolicy,
  AiDmCommitGrant,
  AiDmExpectedRevision,
  AiDmJsonValue,
  AiDmRunPrincipal,
  AiDmToolEffect,
  AiDmToolRisk,
} from "@foundry-ai-dungeon-master/shared";

export interface AiDmPolicyToolRecord {
  toolId: string;
  revision: string;
  schemaDigest: string;
  effects: AiDmToolEffect[];
  risk: AiDmToolRisk;
  approvalPolicy: AiDmApprovalPolicy;
  available: boolean;
  requiredPermissions: string[];
  supportsExpectedRevision: boolean;
  supportsIdempotency: boolean;
}

export interface AiDmPolicyCatalog {
  catalogRevision: string;
  policyRevision: string;
  get(toolId: string): AiDmPolicyToolRecord | undefined;
}

export interface AiDmModelProposalInput {
  proposalId: string;
  runId: string;
  causeEventId: string;
  summary: string;
  expiresAt: string;
  operations: Array<{
    operationId: string;
    toolId: string;
    arguments: AiDmJsonValue;
    expectedRevisions: AiDmExpectedRevision[];
  }>;
}

export type AiDmPolicyOutcome =
  | {
      decision: "auto-commit" | "require-player" | "require-gm";
      proposal: AiDmActionProposal;
    }
  | { decision: "refuse"; code: string; message: string };

export interface AiDmCommitAuthorizationInput {
  proposal: AiDmActionProposal;
  principal: AiDmRunPrincipal;
  approval: AiDmApprovalDecision | null;
  currentRevisions: AiDmExpectedRevision[];
  now: string;
}

export type AiDmCommitAuthorizationResult =
  { allowed: true; grant: AiDmCommitGrant } | { allowed: false; code: string; message: string };

export function gmScope(): AiDmAccessScope {
  return { kind: "gm" };
}
