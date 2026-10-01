import type {
  AiDmApprovalPolicy,
  AiDmJsonValue,
  AiDmRunPrincipal,
  AiDmToolDenial,
  AiDmToolDiscoveryDescriptor,
  AiDmToolEffect,
  AiDmToolGrant,
  AiDmToolRisk,
} from "@foundry-ai-dungeon-master/shared";

export interface ProviderToolDefinition {
  toolId: string;
  description: string;
  inputSchema: AiDmJsonValue;
  outputSchema: AiDmJsonValue | null;
  annotations?: Readonly<Record<string, AiDmJsonValue>>;
}

export interface ProviderToolSnapshot {
  providerId: string;
  providerVersion: string;
  revision: string;
  tools: ProviderToolDefinition[];
}

export interface ProviderInvocation {
  providerId: string;
  toolId: string;
  arguments: AiDmJsonValue;
  schemaDigest: string;
  idempotencyKey: string | null;
}

/**
 * Injected boundary for the authenticated foundry-local-api MCP connection.
 * Network transport is intentionally outside this package and is never used
 * by the catalog tests.
 */
export interface ToolCatalogProvider {
  snapshot(): Promise<ProviderToolSnapshot>;
  invokeSelected(invocation: ProviderInvocation): Promise<AiDmJsonValue>;
}

export type CatalogPrincipalKind = "authenticated" | "gm";

export interface ToolGuarantees {
  expectedRevision: boolean;
  idempotentCommit: boolean;
}

export interface ToolMetadataOverlay {
  toolId: string;
  displayName: string;
  purpose: string;
  useCases: readonly string[];
  effects: readonly AiDmToolEffect[];
  acceptsEntityTypes: readonly string[];
  producesEntityTypes: readonly string[];
  relatedToolIds: readonly string[];
  risk: AiDmToolRisk;
  approvalPolicy: AiDmApprovalPolicy;
  requiredPermissions: readonly string[];
  discoverableBy: readonly CatalogPrincipalKind[];
  executableBy: readonly CatalogPrincipalKind[];
  idempotency: AiDmToolDiscoveryDescriptor["idempotency"];
  guarantees: ToolGuarantees;
  keywords: readonly string[];
  enabled?: boolean;
  unavailableReasonCode?: string;
}

export interface CatalogToolRecord {
  descriptor: AiDmToolDiscoveryDescriptor;
  definition: ProviderToolDefinition;
  metadata: ToolMetadataOverlay;
  schemaDigest: string;
}

export interface CatalogSnapshot {
  providerId: string;
  providerVersion: string;
  providerRevision: string;
  catalogRevision: string;
  policyVersion: string;
  records: ReadonlyMap<string, CatalogToolRecord>;
  quarantinedToolIds: readonly string[];
}

export interface ToolSearchReceipt {
  searchId: string;
  runId: string;
  principalUserId: string;
  query: string;
  normalizedTerms: string[];
  catalogRevision: string;
  policyViewRevision: string;
  returnedToolIds: string[];
  scores: Record<string, number>;
  occurredAt: string;
}

export interface ToolLoadReceipt {
  loadId: string;
  runId: string;
  searchId: string;
  toolId: string;
  toolRevision: string;
  schemaDigest: string;
  grantId: string;
  catalogRevision: string;
  policyViewRevision: string;
  occurredAt: string;
}

export interface ToolExecutionReceipt {
  executionId: string;
  runId: string;
  grantId: string;
  toolId: string;
  effect: AiDmToolEffect;
  argumentsDigest: string;
  outcome: "proposed" | "executed" | "replayed" | "denied" | "failed";
  idempotencyKey: string | null;
  occurredAt: string;
}

export interface RunToolBudgets {
  maxSearches: number;
  maxLoadedDefinitions: number;
  maxToolCalls: number;
}

export interface ToolCatalogClock {
  now(): Date;
}

export interface ToolCatalogIds {
  nextId(prefix: "search" | "load" | "grant" | "execution"): string;
}

export interface ToolCatalogSessionOptions {
  runId: string;
  principal: AiDmRunPrincipal;
  budgets: RunToolBudgets;
  grantTtlMs?: number;
}

export interface ToolCatalogResult<T> {
  ok: true;
  value: T;
}

export interface ToolCatalogFailure {
  ok: false;
  denial: AiDmToolDenial;
}

export type ToolCatalogOutcome<T> = ToolCatalogResult<T> | ToolCatalogFailure;

export interface LoadedToolGrant {
  definition: import("@foundry-ai-dungeon-master/shared").AiDmLoadedToolDefinition;
  grant: AiDmToolGrant;
}

export interface ToolExecutionRequest {
  grantId: string;
  effect: AiDmToolEffect;
  arguments: AiDmJsonValue;
  commitAuthorization?: ToolCommitAuthorization;
}

export interface ToolCommitAuthorization {
  authorizationId: string;
  expectedRevisionCount: number;
  idempotencyKey: string;
}

export interface ToolCommitAuthorizationRequest {
  runId: string;
  principal: AiDmRunPrincipal;
  grantId: string;
  toolId: string;
  argumentsDigest: string;
  authorization: ToolCommitAuthorization;
}

/** Implemented by the proposal/approval store; deny-by-default when absent. */
export interface ToolCommitAuthorizer {
  authorize(request: ToolCommitAuthorizationRequest): Promise<boolean>;
}

export type ToolExecutionResult =
  | {
      kind: "proposal-required";
      toolId: string;
      arguments: AiDmJsonValue;
      approvalPolicy: AiDmApprovalPolicy;
      reason: string;
    }
  | { kind: "executed"; toolId: string; result: AiDmJsonValue; replayed: boolean };
