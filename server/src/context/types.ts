import type {
  AiDmAccessScope,
  AiDmContextBudget,
  AiDmContextEdge,
  AiDmContextNode,
  AiDmContextReceipt,
  AiDmContextView,
  AiDmNormalizedEvent,
  AiDmResolutionFact,
  AiDmRunPrincipal,
  AiDmRuntimeProjection,
  AiDmSourceSpan,
  AiDmVisibility,
} from "@foundry-ai-dungeon-master/shared";

export type ContextSectionKind =
  | "frontmatter"
  | "player-visible"
  | "observable"
  | "discoverable"
  | "gm-only"
  | "state-change"
  | "foundry-sync"
  | "next-load"
  | "source-provenance"
  | "unclassified";

export interface ContextEdgeRecord extends AiDmContextEdge {
  edgeId: string;
  conditionRef: string | null;
  explicitExpansionRequired: boolean;
  sourceSpan: AiDmSourceSpan | null;
}

export interface ContextNodeRecord {
  node: AiDmContextNode;
  visibility: AiDmVisibility;
  sectionKind: ContextSectionKind;
  edges: ContextEdgeRecord[];
}

export interface ParsedCampaignDocument {
  rootId: string;
  relativePath: string;
  sourceUri: string;
  sourceHash: string;
  frontmatter: Readonly<Record<string, string>>;
  records: ContextNodeRecord[];
}

export interface ContextPrincipal {
  runPrincipal: AiDmRunPrincipal;
  resolverCanReadSecrets: boolean;
  presenterAudienceScope?: AiDmAccessScope;
}

export interface ContextRunSeed {
  runId: string;
  threadId: string;
  event: AiDmNormalizedEvent;
  principal: AiDmRunPrincipal;
  projection: AiDmRuntimeProjection;
  budget: AiDmContextBudget;
  directNodeIds: string[];
  synchronizationConflicts?: string[];
  activeConditionRefs?: string[];
  activatedEdgeIds?: string[];
  resolutionFacts?: AiDmResolutionFact[];
  resolverCanReadSecrets?: boolean;
  /** The complete audience that must be allowed to receive presenter-view nodes. */
  presenterAudienceScope?: AiDmAccessScope;
}

export interface RootManifestBody {
  manifestRevision: string;
  event: {
    eventId: string;
    sequence: number;
    eventType: string;
    source: string;
    occurredAt: string;
  };
  principal: {
    userId: string;
    worldId: string;
    isGm: boolean;
    role: number;
    permissionSnapshotRevision: string;
  };
  runtime: {
    projectionId: string;
    revision: string;
    capturedAt: string;
    activeSceneId: string | null;
    controlledTokenIds: string[];
    controlledActorIds: string[];
    targetTokenIds: string[];
    selectedDocumentUuids: string[];
    activeCombatId: string | null;
    activeCombatantId: string | null;
    activeCombatantTokenId: string | null;
    activeCombatantActorId: string | null;
    combatRound: number | null;
    combatTurn: number | null;
    campaignStateRevision: string | null;
    sourceRevisions: Record<string, string>;
  };
  directNodeIds: string[];
  synchronizationConflicts: string[];
  budgets: AiDmContextBudget;
}

export interface ContextRunState {
  seed: ContextRunSeed;
  root: AiDmContextNode;
  activeConditionRefs: ReadonlySet<string>;
  activatedEdgeIds: ReadonlySet<string>;
  resolutionFacts: readonly AiDmResolutionFact[];
  receipt: ContextReceiptAccumulator;
}

export interface ContextReceiptAccumulator {
  entries: AiDmContextReceipt["entries"];
  readsUsed: number;
  nodeKeys: Set<string>;
  charactersUsed: number;
  estimatedTokensUsed: number;
  maximumDepthUsed: number;
  budgetExhausted: boolean;
}

export interface ContextSourceReader {
  readSource(
    sourceUri: string,
    span: AiDmSourceSpan,
  ): {
    text: string;
    sourceHash: string;
    span: AiDmSourceSpan;
  };
}

export interface ScopeExpectation {
  worldId: string;
  threadId: string;
  principalUserId: string;
  disclosureScope: AiDmAccessScope;
  isGm: boolean;
  now: Date;
}

export interface ContextAccessDecision {
  allowed: boolean;
  visibility: AiDmVisibility;
  reason: "allowed" | "inactive" | "read-scope" | "disclosure-scope" | "secret";
}

export interface ContextViewRequest {
  view: AiDmContextView;
  principal: ContextPrincipal;
  activeConditionRefs: ReadonlySet<string>;
}

export class ContextError extends Error {
  constructor(
    readonly code:
      | "CONTEXT_BUDGET_EXCEEDED"
      | "CONTEXT_NOT_VISIBLE"
      | "CONTEXT_STALE"
      | "CAPSULE_STALE"
      | "SOURCE_OUTSIDE_ROOT"
      | "SOURCE_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "ContextError";
  }
}
