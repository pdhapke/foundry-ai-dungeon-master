import type {
  AiDmAccessScope,
  AiDmContextNode,
  AiDmJsonValue,
} from "@foundry-ai-dungeon-master/shared";

import { revisionOf } from "./hash.js";
import type { ContextNodeRecord, ContextRunSeed, RootManifestBody } from "./types.js";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildDeterministicRoot(seed: ContextRunSeed): {
  manifest: RootManifestBody;
  record: ContextNodeRecord;
} {
  const { event, principal, projection } = seed;
  if (event.eventId !== projection.eventId) {
    throw new Error("Runtime projection event binding does not match the triggering event.");
  }
  if (
    principal.userId !== event.authenticatedIdentity.userId ||
    principal.worldId !== event.authenticatedIdentity.worldId ||
    projection.authoritativeUserId !== principal.userId ||
    projection.worldId !== principal.worldId
  ) {
    throw new Error(
      "Runtime projection identity binding does not match the authenticated principal.",
    );
  }
  const base = {
    event: {
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.eventType,
      source: event.source,
      occurredAt: event.occurredAt,
    },
    principal: {
      userId: principal.userId,
      worldId: principal.worldId,
      isGm: principal.isGm,
      role: principal.role,
      permissionSnapshotRevision: principal.permissionSnapshotRevision,
    },
    runtime: {
      projectionId: projection.projectionId,
      revision: projection.revision,
      capturedAt: projection.capturedAt,
      activeSceneId: projection.activeSceneId,
      controlledTokenIds: sortedUnique(projection.controlledTokenIds),
      controlledActorIds: sortedUnique(projection.controlledActorIds),
      targetTokenIds: sortedUnique(projection.targetTokenIds),
      selectedDocumentUuids: sortedUnique(projection.selectedDocumentUuids),
      activeCombatId: projection.activeCombatId,
      activeCombatantId: projection.activeCombatantId,
      activeCombatantTokenId: projection.activeCombatantTokenId,
      activeCombatantActorId: projection.activeCombatantActorId,
      combatRound: projection.combatRound,
      combatTurn: projection.combatTurn,
      campaignStateRevision: projection.campaignStateRevision,
      sourceRevisions: Object.fromEntries(
        Object.entries(projection.sourceRevisions).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
    directNodeIds: sortedUnique(seed.directNodeIds),
    synchronizationConflicts: sortedUnique(seed.synchronizationConflicts ?? []),
    budgets: structuredClone(seed.budget),
  };
  const manifestRevision = revisionOf(base);
  const manifest: RootManifestBody = { manifestRevision, ...base };
  const scope: AiDmAccessScope = principal.isGm
    ? { kind: "gm" }
    : { kind: "users", userIds: [principal.userId] };
  const node: AiDmContextNode = {
    nodeId: `root:${seed.runId}`,
    kind: "root",
    revision: manifestRevision,
    authoritative: true,
    authority: "operational",
    readScope: scope,
    disclosureScope: scope,
    activation: { status: "active", conditionRef: null },
    title: "AI Dungeon Master root context",
    contentType: "application/json",
    body: manifest as unknown as AiDmJsonValue,
    sourceUri: null,
    sourceHash: null,
    sourceSpan: null,
    edges: manifest.directNodeIds.map((targetNodeId) => ({
      relation: "direct-context",
      targetNodeId,
      visibility: principal.isGm ? "gm" : "player",
    })),
    dependencies: [],
    stale: false,
  };
  return {
    manifest,
    record: {
      node,
      visibility: principal.isGm ? "gm" : "player",
      sectionKind: "unclassified",
      edges: manifest.directNodeIds.map((targetNodeId) => ({
        edgeId: `root-edge:${revisionOf(targetNodeId).slice(0, 24)}`,
        relation: "direct-context",
        targetNodeId,
        visibility: principal.isGm ? "gm" : "player",
        conditionRef: null,
        explicitExpansionRequired: false,
        sourceSpan: null,
      })),
    },
  };
}
