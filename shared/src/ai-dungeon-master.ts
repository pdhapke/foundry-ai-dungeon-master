export const AI_DM_PROTOCOL_VERSION = 2 as const;

export type AiDmId = string;
export type AiDmJsonPrimitive = string | number | boolean | null;
export type AiDmJsonValue = AiDmJsonPrimitive | AiDmJsonValue[] | { [key: string]: AiDmJsonValue };

export type AiDmClientLane = "gm" | "player" | "tv";
export type AiDmVisibility = "public" | "player" | "gm" | "secret";
export type AiDmDeliveryClass = "public" | "private" | "gm" | "operational";
export type AiDmPresentationPolicy =
  "silent" | "collapsed" | "normal" | "interrupting" | "approval-required";

export type AiDmRequestedAudience =
  | { kind: "private" }
  | { kind: "gm" }
  | { kind: "selected-users"; recipientUserIds: AiDmId[] }
  | { kind: "table" };

export type AiDmAccessScope =
  { kind: "public" } | { kind: "gm" } | { kind: "users"; userIds: readonly AiDmId[] };

export interface AiDmEffectiveAudience {
  scope: AiDmAccessScope;
  transcript: boolean;
  mirrorToFoundryChat: boolean;
}

export interface AiDmAuthenticatedIdentity {
  clientId: AiDmId;
  userId: AiDmId;
  lane: AiDmClientLane;
  worldId: AiDmId;
  isGm: boolean;
}

export interface AiDmRunPrincipal extends AiDmAuthenticatedIdentity {
  connectionId: AiDmId;
  role: number;
  authorizedAudienceKinds: AiDmRequestedAudience["kind"][];
  permissionSnapshotRevision: string;
}

export interface AiDmContextHints {
  sceneId?: AiDmId;
  controlledTokenIds?: AiDmId[];
  controlledActorIds?: AiDmId[];
  targetTokenIds?: AiDmId[];
  selectedDocumentUuids?: string[];
}

export type AiDmEventSource =
  "direct-prompt" | "audio-transcript" | "foundry-hook" | "explicit-gm-request" | "retry";

export interface AiDmNormalizedEvent {
  schemaVersion: 1;
  eventId: AiDmId;
  sequence: number;
  eventType: string;
  source: AiDmEventSource;
  occurredAt: string;
  receivedAt: string;
  authenticatedIdentity: AiDmAuthenticatedIdentity;
  presentation: AiDmPresentationPolicy;
  requestedAudience: AiDmRequestedAudience;
  contextHints: AiDmContextHints;
  payload: AiDmJsonValue;
  payloadHash: string;
  sourceCorrelationId: string;
  deduplicationKey: string;
  sourceStateRevision: string | null;
  causeEventId?: AiDmId;
}

export interface AiDmRuntimeProjection {
  projectionId: AiDmId;
  eventId: AiDmId;
  revision: string;
  capturedAt: string;
  worldId: AiDmId;
  authoritativeUserId: AiDmId;
  permissionRole: number;
  activeSceneId: AiDmId | null;
  controlledTokenIds: AiDmId[];
  controlledActorIds: AiDmId[];
  targetTokenIds: AiDmId[];
  activeCombatId: AiDmId | null;
  activeCombatantId: AiDmId | null;
  activeCombatantTokenId: AiDmId | null;
  activeCombatantActorId: AiDmId | null;
  combatRound: number | null;
  combatTurn: number | null;
  campaignStateRevision: string | null;
  sourceRevisions: Record<string, string>;
  selectedDocumentUuids: string[];
}

export type AiDmContextNodeKind =
  | "root"
  | "campaign-source"
  | "campaign-state"
  | "foundry-document"
  | "runtime-projection"
  | "derived-summary";

export type AiDmContextAuthority = "narrative-filesystem" | "foundry" | "operational" | "derived";

export interface AiDmSourceSpan {
  startLine: number;
  endLine: number;
}

export interface AiDmContextActivation {
  status: "active" | "inactive" | "conditional";
  conditionRef: string | null;
}

export interface AiDmContextEdge {
  relation: string;
  targetNodeId: AiDmId;
  visibility: AiDmVisibility;
}

export interface AiDmContextDependency {
  nodeId: AiDmId;
  revision: string;
}

export interface AiDmContextNode {
  nodeId: AiDmId;
  kind: AiDmContextNodeKind;
  revision: string;
  authoritative: boolean;
  authority: AiDmContextAuthority;
  readScope: AiDmAccessScope;
  disclosureScope: AiDmAccessScope;
  activation: AiDmContextActivation;
  title: string;
  contentType: string;
  body: AiDmJsonValue;
  sourceUri: string | null;
  sourceHash: string | null;
  sourceSpan: AiDmSourceSpan | null;
  edges: AiDmContextEdge[];
  dependencies: AiDmContextDependency[];
  stale: boolean;
}

export type AiDmContextOperation =
  | "context_get_root"
  | "context_read"
  | "context_expand"
  | "context_search"
  | "context_get_changes"
  | "context_get_source";

export type AiDmContextView = "resolver" | "presenter";

export interface AiDmContextRequest {
  requestId: AiDmId;
  runId: AiDmId;
  operation: AiDmContextOperation;
  view: AiDmContextView;
  nodeIds: AiDmId[];
  query?: string;
  relation?: string;
  maxDepth?: number;
  sourceSpan?: AiDmSourceSpan;
}

export interface AiDmContextResult {
  requestId: AiDmId;
  operation: AiDmContextOperation;
  nodes: AiDmContextNode[];
  partial: boolean;
  denialCode?: AiDmContextErrorCode;
}

export type AiDmContextErrorCode =
  | "CONTEXT_BUDGET_EXCEEDED"
  | "CONTEXT_NOT_VISIBLE"
  | "CONTEXT_STALE"
  | "CAPSULE_STALE"
  | "SOURCE_OUTSIDE_ROOT"
  | "SOURCE_NOT_ALLOWED";

export interface AiDmResolutionFact {
  factId: AiDmId;
  runId: AiDmId;
  sourceNodeRevisions: AiDmContextDependency[];
  kind: string;
  value: AiDmJsonValue;
  visibility: AiDmVisibility;
  declassificationPolicy: "none" | "reveal-to-initiator" | "reveal-to-audience";
  policyRevision: string;
}

export interface AiDmContextBudget {
  maxReads: number;
  maxDepth: number;
  maxNodes: number;
  maxCharacters: number;
  maxEstimatedTokens: number;
}

export interface AiDmContextReceiptEntry {
  nodeId: AiDmId;
  revision: string;
  operation: "root" | "read" | "expand" | "search" | "changes" | "source";
  visibilityApplied: AiDmVisibility;
}

export interface AiDmContextReceipt {
  receiptId: AiDmId;
  runId: AiDmId;
  contextGraphRevision: string;
  entries: AiDmContextReceiptEntry[];
  readsUsed: number;
  nodesUsed: number;
  charactersUsed: number;
  estimatedTokensUsed: number;
  maximumDepthUsed: number;
  budgetExhausted: boolean;
  completedAt: string;
}

export interface AiDmContinuationCapsule {
  capsuleId: AiDmId;
  threadId: AiDmId;
  worldId: AiDmId;
  principalUserId: AiDmId;
  disclosureScope: AiDmAccessScope;
  priorRunId: AiDmId;
  priorEventId: AiDmId;
  createdAt: string;
  expiresAt: string;
  visibility: AiDmVisibility;
  summary: string;
  unresolvedReferences: string[];
  sourceNodeRevisions: AiDmContextDependency[];
  checksum: string;
  signature: string;
}

export type AiDmToolEffect = "read" | "simulate" | "present" | "propose" | "commit";
export type AiDmToolRisk = "none" | "low" | "consequential" | "destructive";
export type AiDmApprovalPolicy = "none" | "player-confirmation" | "gm-approval" | "always-refuse";

export interface AiDmToolDiscoveryDescriptor {
  toolId: AiDmId;
  revision: string;
  displayName: string;
  purpose: string;
  useCases: string[];
  effects: AiDmToolEffect[];
  acceptsEntityTypes: string[];
  producesEntityTypes: string[];
  relatedToolIds: AiDmId[];
  risk: AiDmToolRisk;
  approvalPolicy: AiDmApprovalPolicy;
  requiredPermissions: string[];
  availability: "available" | "unavailable";
  unavailableReasonCode?: string;
  idempotency: "not-applicable" | "required" | "provider-guaranteed";
  schemaRef: string;
  keywords: string[];
}

export interface AiDmToolSearchRequest {
  query: string;
  alreadyLoaded: AiDmId[];
  limit: number;
}

export interface AiDmToolSearchResult {
  searchId: AiDmId;
  catalogRevision: string;
  policyViewRevision: string;
  query: string;
  descriptors: AiDmToolDiscoveryDescriptor[];
}

export interface AiDmLoadedToolDefinition {
  runId: AiDmId;
  searchId: AiDmId;
  toolId: AiDmId;
  revision: string;
  catalogRevision: string;
  inputSchema: AiDmJsonValue;
  outputSchema: AiDmJsonValue | null;
  schemaDigest: string;
  loadedAt: string;
  risk: AiDmToolRisk;
  approvalPolicy: AiDmApprovalPolicy;
  policyRevision: string;
}

export interface AiDmToolGrant {
  grantId: AiDmId;
  runId: AiDmId;
  principalUserId: AiDmId;
  toolId: AiDmId;
  toolRevision: string;
  catalogRevision: string;
  policyViewRevision: string;
  schemaDigest: string;
  allowedEffects: AiDmToolEffect[];
  remainingCalls: number;
  expiresAt: string;
}

export type AiDmToolDenialCode =
  | "TOOL_UNKNOWN"
  | "TOOL_UNAVAILABLE"
  | "TOOL_UNAUTHORIZED"
  | "TOOL_SCHEMA_CHANGED"
  | "TOOL_CATALOG_STALE"
  | "TOOL_GRANT_EXPIRED"
  | "TOOL_BUDGET_EXCEEDED"
  | "TOOL_ARGUMENT_INVALID"
  | "TOOL_REVISION_CONFLICT";

export interface AiDmToolDenial {
  toolId: AiDmId | null;
  code: AiDmToolDenialCode;
  message: string;
  retryable: boolean;
}

export interface AiDmExpectedRevision {
  provider: string;
  resourceKind: string;
  resourceId: AiDmId;
  revision: string;
}

export interface AiDmProposedOperation {
  operationId: AiDmId;
  toolId: AiDmId;
  arguments: AiDmJsonValue;
  expectedRevisions: AiDmExpectedRevision[];
}

export interface AiDmStateDelta {
  deltaId: AiDmId;
  causeEventId: AiDmId;
  stableStateId: string;
  oldValue: AiDmJsonValue;
  newValue: AiDmJsonValue;
  disclosureScope: AiDmAccessScope;
  expectedRevisions: AiDmExpectedRevision[];
  affectedContextNodes: AiDmContextDependency[];
  intendedFilesystemOperations: AiDmJsonValue[];
  intendedFoundryOperations: AiDmProposedOperation[];
}

export interface AiDmCommitOperationGrant {
  operationId: AiDmId;
  toolId: AiDmId;
  toolRevision: string;
  schemaDigest: string;
  argumentsDigest: string;
  expectedRevisions: AiDmExpectedRevision[];
  idempotencyKey: string;
  maximumCalls: number;
}

export interface AiDmCommitGrant {
  commitGrantId: AiDmId;
  proposalId: AiDmId;
  proposalRevision: string;
  policyRevision: string;
  catalogRevision: string;
  issuedAt: string;
  expiresAt: string;
  operations: AiDmCommitOperationGrant[];
}

export type AiDmProposalStatus =
  | "pending-policy"
  | "waiting-for-player"
  | "waiting-for-gm"
  | "approved"
  | "refused"
  | "expired"
  | "committing"
  | "committed"
  | "conflicted"
  | "failed";

export interface AiDmActionProposal {
  proposalId: AiDmId;
  runId: AiDmId;
  causeEventId: AiDmId;
  createdAt: string;
  expiresAt: string;
  status: AiDmProposalStatus;
  proposalRevision: string;
  policyRevision: string;
  catalogRevision: string;
  summary: string;
  effectiveAudience: AiDmEffectiveAudience;
  approvalAuthority: AiDmAccessScope;
  operations: AiDmProposedOperation[];
  stateDeltas: AiDmStateDelta[];
}

export interface AiDmApprovalRequest {
  requestId: AiDmId;
  proposalId: AiDmId;
  decision: "approve" | "refuse";
  proposalRevision: string;
}

export interface AiDmApprovalDecision {
  decisionId: AiDmId;
  proposalId: AiDmId;
  decision: "approve" | "refuse";
  decidedAt: string;
  authenticatedIdentity: AiDmAuthenticatedIdentity;
  proposalRevision: string;
}

export interface AiDmSynchronizationResult {
  operationId: AiDmId;
  provider: string;
  resourceKind: string;
  resourceId: AiDmId | null;
  status: "verified" | "pending" | "failed" | "recovery-required";
  foundryDocumentIds: AiDmId[];
  expectedRevision: string | null;
  observedRevision: string | null;
  filesystemStatus: "not-applicable" | "verified" | "pending" | "failed";
  readBackRevision: string | null;
  readBackDigest: string | null;
  reconciliationRequired: boolean;
  safeErrorCode?: string;
}

export type AiDmRunStatus =
  | "queued"
  | "projecting"
  | "reading-context"
  | "searching-tools"
  | "resolving"
  | "waiting-for-player"
  | "waiting-for-gm"
  | "committing"
  | "delivering"
  | "complete"
  | "failed"
  | "cancelled";

export const AI_DM_TERMINAL_RUN_STATUSES: readonly AiDmRunStatus[] = [
  "complete",
  "failed",
  "cancelled",
];

export function isAiDmTerminalRunStatus(status: AiDmRunStatus): boolean {
  return AI_DM_TERMINAL_RUN_STATUSES.includes(status);
}

export interface AiDmRun {
  runId: AiDmId;
  eventId: AiDmId;
  threadId: AiDmId;
  principal: AiDmRunPrincipal;
  attempt: number;
  status: AiDmRunStatus;
  statusRevision: number;
  createdAt: string;
  updatedAt: string;
  providerResponseId: string | null;
  providerResponseRunBinding: AiDmId | null;
  budgets: AiDmRunBudgets;
  cancelRequestedAt: string | null;
  failureCode: string | null;
}

export interface AiDmRunBudgets {
  context: AiDmContextBudget;
  maxToolSearches: number;
  maxLoadedDefinitions: number;
  maxToolCalls: number;
  maxProposalOperations: number;
  maxOutputCharacters: number;
  maxProviderAttempts: number;
  maxWallClockMs: number;
}

export interface AiDmThread {
  threadId: AiDmId;
  worldId: AiDmId;
  ownerUserId: AiDmId;
  participantScope: AiDmAccessScope;
  authorizedAudienceKinds: AiDmRequestedAudience["kind"][];
  revision: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type AiDmMessageKind =
  | "prompt"
  | "progress"
  | "narration"
  | "clarification"
  | "roll"
  | "choice"
  | "approval"
  | "diagnostic"
  | "error";

export interface AiDmMessage {
  messageId: AiDmId;
  threadId: AiDmId;
  threadSequence: number;
  runId: AiDmId | null;
  eventId: AiDmId;
  kind: AiDmMessageKind;
  deliveryClass: AiDmDeliveryClass;
  effectiveAudience: AiDmEffectiveAudience;
  createdAt: string;
  content: AiDmMessageContent;
}

export type AiDmMessageContent =
  | { kind: "plain-text"; text: string }
  | { kind: "structured-card"; cardType: string; data: AiDmJsonValue };

export interface AiDmPromptSubmit {
  requestId: AiDmId;
  text: string;
  requestedAudience: AiDmRequestedAudience;
  contextHints: AiDmContextHints;
}

export interface AiDmPlayerPromptRequest {
  playerRequestId: AiDmId;
  requesterUserId: AiDmId;
  text: string;
  status: "waiting-for-gm" | "approved" | "refused";
  requestedAt: string;
}

export interface AiDmHistoryFetch {
  requestId: AiDmId;
  threadId?: AiDmId;
  afterSequence?: number;
  limit: number;
}

export interface AiDmAutomaticEventSubmit {
  requestId: AiDmId;
  eventType:
    | "combat.turn.changed"
    | "door.state.changed"
    | "region.transition"
    | "item.used"
    | "roll.resolved"
    | "scene.changed";
  sourceCorrelationId: string;
  presentation: AiDmPresentationPolicy;
  contextHints: AiDmContextHints;
  payload: AiDmJsonValue;
}

export interface AiDmConnectHello {
  protocolVersion: typeof AI_DM_PROTOCOL_VERSION;
  clientId: AiDmId;
  browserSessionId: AiDmId;
  sessionCredential: string;
  moduleVersion: string;
}

export interface AiDmAuthIdentify {
  protocolVersion: typeof AI_DM_PROTOCOL_VERSION;
  clientId: AiDmId;
  browserSessionId: AiDmId;
  worldId: AiDmId;
  moduleVersion: string;
}

export interface AiDmAuthAssertion {
  protocolVersion: typeof AI_DM_PROTOCOL_VERSION;
  clientId: AiDmId;
  browserSessionId: AiDmId;
  assertion: string;
  moduleVersion: string;
}

export type AiDmClientMessage =
  | { type: "aiDm.chatgpt.signin.begin"; payload: { requestId: AiDmId } }
  | { type: "aiDm.chatgpt.status"; payload: { requestId: AiDmId } }
  | {
      type: "aiDm.chatgpt.model.select";
      payload: { requestId: AiDmId; model: string };
    }
  | { type: "aiDm.chatgpt.signout"; payload: { requestId: AiDmId } }
  | { type: "aiDm.player-requests.status"; payload: { requestId: AiDmId } }
  | {
      type: "aiDm.player-requests.policy.set";
      payload: { requestId: AiDmId; allowAll: boolean };
    }
  | {
      type: "aiDm.player-request.decide";
      payload: { requestId: AiDmId; playerRequestId: AiDmId; decision: "approve" | "refuse" };
    }
  | { type: "aiDm.prompt.submit"; payload: AiDmPromptSubmit }
  | { type: "aiDm.event.submit"; payload: AiDmAutomaticEventSubmit }
  | { type: "aiDm.run.cancel"; payload: { requestId: AiDmId; runId: AiDmId } }
  | { type: "aiDm.run.retry"; payload: { requestId: AiDmId; runId: AiDmId } }
  | { type: "aiDm.approval.decide"; payload: AiDmApprovalRequest }
  | {
      type: "aiDm.choice.submit";
      payload: { requestId: AiDmId; messageId: AiDmId; choiceId: AiDmId };
    }
  | { type: "aiDm.history.fetch"; payload: AiDmHistoryFetch };

export interface AiDmApprovalCard {
  proposalId: AiDmId;
  proposalRevision: string;
  summary: string;
  expiresAt: string;
  operationSummaries: string[];
  approvalAuthority: AiDmAccessScope;
}

export type AiDmServerPayload =
  | { type: "aiDm.message.created"; payload: AiDmMessage }
  | {
      type: "aiDm.run.acknowledged";
      payload: { requestId: AiDmId; eventId: AiDmId; runId: AiDmId; threadId: AiDmId };
    }
  | {
      type: "aiDm.run.status";
      payload: { runId: AiDmId; status: AiDmRunStatus; occurredAt: string };
    }
  | {
      type: "aiDm.output.delta";
      payload: {
        runId: AiDmId;
        messageId: AiDmId;
        deltaSequence: number;
        offset: number;
        messageRevision: number;
        delta: string;
        final: boolean;
      };
    }
  | { type: "aiDm.approval.required"; payload: AiDmApprovalCard }
  | {
      type: "aiDm.run.completed";
      payload: {
        runId: AiDmId;
        diagnostics?: { receipt: AiDmContextReceipt; capsule: AiDmContinuationCapsule };
      };
    }
  | {
      type: "aiDm.run.failed";
      payload: {
        runId: AiDmId;
        code: string;
        message: string;
        retryable: boolean;
        diagnostics?: {
          httpStatus?: number;
          providerCode?: string;
          providerType?: string;
          providerParam?: string;
          requestId?: string;
          terminalEventType?: string;
        };
      };
    }
  | {
      type: "aiDm.history.result";
      payload: {
        requestId: AiDmId;
        threadId: AiDmId;
        messages: AiDmMessage[];
        runs?: Array<{ runId: AiDmId; status: AiDmRunStatus; failureCode: string | null }>;
        hasMore: boolean;
      };
    };

export interface AiDmServerDelivery {
  protocolVersion: typeof AI_DM_PROTOCOL_VERSION;
  deliveryId: AiDmId;
  recipientUserId: AiDmId;
  recipientSequence: number;
  worldId: AiDmId;
  threadId: AiDmId | null;
  runId: AiDmId | null;
  occurredAt: string;
  message: AiDmServerPayload;
}

export type AiDmTransportClientMessage =
  | { type: "aiDm.connect"; payload: AiDmConnectHello }
  | { type: "aiDm.auth.identify"; payload: AiDmAuthIdentify }
  | { type: "aiDm.auth.assertion"; payload: AiDmAuthAssertion }
  | { type: "aiDm.command"; payload: AiDmClientMessage };

export type AiDmTransportServerMessage =
  | {
      type: "aiDm.connected";
      payload: {
        clientId: AiDmId;
        userId: AiDmId;
        worldId: AiDmId;
        lane: AiDmClientLane;
        sessionExpiresAt: string;
      };
    }
  | {
      type: "aiDm.auth.challenge";
      payload: {
        challengeId: AiDmId;
        challenge: string;
        connectionId: AiDmId;
        expiresAt: string;
      };
    }
  | {
      type: "aiDm.auth.accepted";
      payload: { clientId: AiDmId; sessionCredential: string; expiresAt: string };
    }
  | {
      type: "aiDm.connection.refused";
      payload: { code: string; message: string; retryable: boolean };
    }
  | {
      type: "aiDm.chatgpt.signin.started";
      payload: { requestId: AiDmId; authorizationUrl: string };
    }
  | {
      type: "aiDm.chatgpt.status";
      payload: {
        requestId: AiDmId;
        state: "signed-out" | "connected";
        identityConnected: boolean;
        planUsageAuthorized: boolean;
        modelDiscoveryState: "not-authorized" | "unavailable" | "empty" | "available";
        remoteRevocationConfirmed?: boolean;
        gmUserId?: AiDmId;
        email?: string;
        expiresAt?: string;
        availableModels: Array<{ slug: string; displayName: string }>;
        selectedModel: string | null;
      };
    }
  | {
      type: "aiDm.player-requests.state";
      payload: {
        requestId: AiDmId;
        allowAll: boolean;
        requests: AiDmPlayerPromptRequest[];
      };
    }
  | { type: "aiDm.delivery"; payload: AiDmServerDelivery };
