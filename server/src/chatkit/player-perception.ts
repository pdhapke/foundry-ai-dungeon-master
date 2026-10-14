import { z } from "zod";
import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { hashText } from "../context/hash.js";
import type { PlayerDescriptionPlan } from "../context/world-campaign.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const readiness = z.enum(["complete", "incomplete", "unsupported"]);
const flags = z.object({
  selectedUser: z.literal(true),
  selectedToken: z.literal(true),
  tokenOwned: z.literal(true),
  sceneLoaded: z.literal(true),
});
const redaction = z.object({
  occludedEntities: z.literal(true),
  hiddenRegions: z.literal(true),
  barrierDocumentIds: z.literal(true),
  barrierCoordinates: z.literal(true),
  secretDoors: z.literal(true),
  exitDestinations: z.literal(true),
});
const observation = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  worldId: id,
  sceneId: id,
  userId: id,
  tokenId: id,
  actorId: id.nullable(),
  clientId: id,
  isGM: z.literal(false),
  optedIn: z.literal(true),
  capturedAt: z.string().datetime(),
  stateRevision: digest,
  readiness: z.enum(["ready", "stale", "unavailable"]),
  basis: z.literal("request-local-native-render-flags"),
  pendingRenderFlags: z.number().int().min(0).nullable(),
});
const native = z.object({
  sceneId: id,
  tokenId: id,
  effectiveUserId: id,
  status: z.enum(["complete", "incomplete", "asset_error", "unsupported"]),
  issues: z.array(z.unknown()).max(50),
  context: flags,
  redaction,
  observation,
  visible: z.object({
    tokens: z.array(id).max(64),
    notes: z.array(id).max(64),
    tiles: z.array(id).max(64),
  }),
  isolation: z.object({
    status: readiness,
    method: z.enum(["foundry-v14-detection-modes", "selected-source-polygons"]).nullable(),
    detectionModes: z.number().int().min(0).max(64),
  }),
  environment: z.object({
    fog: readiness,
    lighting: readiness,
    darkness: readiness,
    vision: readiness,
    regions: readiness,
    fogExplorationEnabled: z.boolean().nullable(),
    tokenVisionEnabled: z.boolean().nullable(),
    globalLight: z.boolean().nullable(),
    darknessLevel: z.number().finite().min(0).max(1).nullable(),
  }),
  persistence: z.object({ beforeRevision: digest, afterRevision: digest, unchanged: z.boolean() }),
  bounds: z.object({ truncated: z.boolean() }),
  fogRevision: digest.nullable(),
});
const surroundingsNative = native.extend({
  visibleBarriers: z.array(z.object({
    key: z.string().regex(/^(?:barrier|blocker)-\d+$/),
    kind: z.enum(["barrier", "door"]), state: z.enum(["open", "closed", "locked", "unknown"]),
    blocksVision: z.boolean(), exit: z.boolean(), destination: z.literal("redacted"),
  })).max(500),
  queryPoints: z.array(z.object({ id, visible: z.boolean(), regions: z.array(id).max(250),
    blockerAttribution: z.enum(["none", "visible-wall", "out-of-range", "environment-ambiguous", "unavailable"]), blockerKeys: z.array(id).max(500) })).max(8),
});
export interface PlayerObservableFact {
  kind: "visible-barrier" | "visible-door" | "public-description";
  description: string;
  basis: "native-visible-barrier" | "native-visible-query-point";
  decision: { visibility: "public"; audience: { kind: "public" }; activation: { status: "active"; conditionRef: null }; dependencies: Array<{ nodeId: string; revision: string }>; policyRevision: "player-surroundings-v1" };
}
export type SelectedPerception = { sceneId: string; tokenId: string; effectiveUserId: string; clientId: string };
export type PerceptionReason =
  | "PLAYER_CLIENT_UNAVAILABLE"
  | "PERCEPTION_TIMEOUT"
  | "PERCEPTION_UNAVAILABLE"
  | "INVALID_EVIDENCE"
  | "IDENTITY_MISMATCH"
  | "STATE_CHANGED"
  | "PENDING_RENDER"
  | "INCOMPLETE_EVIDENCE";
export function unavailablePerception(
  selected: SelectedPerception,
  reason: PerceptionReason,
  status: "unavailable" | "stale" = "unavailable",
): AiDmJsonValue {
  return {
    sceneId: selected.sceneId,
    tokenId: selected.tokenId,
    effectiveUserId: selected.effectiveUserId,
    clientId: selected.clientId,
    status,
    issues: [{ code: reason, retryable: true }],
    visible: { tokens: [], notes: [], tiles: [] },
    knowledge: "selected-player-only; no GM fallback",
    observation: null,
  };
}
/** Source fields are never spread: no issue text, hidden counts, document metadata or GM context. */
export function projectPlayerPerception(
  raw: unknown,
  selected: SelectedPerception,
  worldId: string,
): AiDmJsonValue {
  const parsed = native.safeParse(raw);
  if (!parsed.success) return unavailablePerception(selected, "INVALID_EVIDENCE");
  const value = parsed.data,
    seen = value.observation;
  if (
    value.sceneId !== selected.sceneId ||
    value.tokenId !== selected.tokenId ||
    value.effectiveUserId !== selected.effectiveUserId ||
    seen.worldId !== worldId ||
    seen.sceneId !== selected.sceneId ||
    seen.tokenId !== selected.tokenId ||
    seen.userId !== selected.effectiveUserId ||
    seen.clientId !== selected.clientId
  )
    return unavailablePerception(selected, "IDENTITY_MISMATCH");
  if (
    seen.readiness === "stale" ||
    !value.persistence.unchanged ||
    value.persistence.beforeRevision !== value.persistence.afterRevision ||
    value.persistence.afterRevision !== seen.stateRevision
  )
    return unavailablePerception(selected, "STATE_CHANGED", "stale");
  if (seen.pendingRenderFlags !== null && seen.pendingRenderFlags > 0)
    return unavailablePerception(selected, "PENDING_RENDER", "stale");
  if (
    seen.readiness !== "ready" ||
    seen.pendingRenderFlags !== 0 ||
    value.status !== "complete" ||
    value.issues.length !== 0 ||
    value.bounds.truncated ||
    value.isolation.status !== "complete" ||
    value.environment.vision !== "complete" ||
    value.environment.fog !== "complete" ||
    value.environment.lighting !== "complete" ||
    value.environment.darkness !== "complete"
  )
    return unavailablePerception(selected, "INCOMPLETE_EVIDENCE");
  return {
    sceneId: selected.sceneId,
    tokenId: selected.tokenId,
    effectiveUserId: selected.effectiveUserId,
    status: "complete",
    issues: [],
    context: value.context,
    redaction: value.redaction,
    visible: value.visible,
    observation: seen,
    isolation: value.isolation,
    environment: value.environment,
    persistence: value.persistence,
    fogRevision: value.fogRevision,
    bounds: value.bounds,
    knowledge:
      "selected-player-only; request-local observation, re-read after changes; no GM fallback",
  };
}

/** Deterministic descriptions only; source IDs/coordinates/rationale never become prose. */
export function projectPlayerSurroundings(raw: unknown, selected: SelectedPerception, worldId: string, plan: PlayerDescriptionPlan): AiDmJsonValue {
  const perception = projectPlayerPerception(raw, selected, worldId) as Record<string, AiDmJsonValue>;
  const unknowns = ["threat", "being-noticed", "trap", "unobserved-area"];
  const failure = (status: string, issues: AiDmJsonValue) => ({ version: 1, status, binding: null, facts: [], unknowns, sourceRevision: null, issues });
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const negative = raw as Record<string, unknown>;
    if (negative["status"] === "stale") return failure("stale", []);
    if (negative["status"] === "unsupported") return failure("unsupported", []);
    if (negative["status"] === "unavailable" && Array.isArray(negative["issues"]) && negative["issues"].some(issue => issue && typeof issue === "object" && (issue as Record<string, unknown>)["code"] === "PLAYER_CLIENT_UNAVAILABLE")) return failure("NOT_CONNECTED", []);
  }
  if (perception["status"] !== "complete") return failure(String(perception["status"]), perception["issues"] ?? []);
  const parsed = surroundingsNative.safeParse(raw);
  if (!parsed.success) return failure("unavailable", [{code:"INVALID_EVIDENCE",retryable:false}]);
  const value = parsed.data, seen = value.observation;
  const facts: PlayerObservableFact[] = [];
  const decision = (nodeId: string, revision: string): PlayerObservableFact["decision"] => ({ visibility: "public", audience: { kind: "public" }, activation: { status: "active", conditionRef: null }, dependencies: [{nodeId,revision}], policyRevision: "player-surroundings-v1" });
  for (const barrier of value.visibleBarriers.slice(0, 8)) {
    const description = barrier.kind === "door"
      ? barrier.state === "open" ? "An open door is visible." : ["closed", "locked"].includes(barrier.state) ? "A closed door is visible." : "A door is visible; its state is uncertain."
      : barrier.blocksVision ? "A visible barrier obstructs sight." : "A barrier is visible.";
    facts.push({ kind: barrier.kind === "door" ? "visible-door" : "visible-barrier", description, basis: "native-visible-barrier", decision: decision(hashText(barrier.key), seen.stateRevision) });
  }
  // Each authored point must have exactly one validated response; no region/token membership inference.
  for (const item of plan.descriptions) {
    const query = value.queryPoints.filter(point => point.id === item.queryId);
    if (!plan.points.some(point => point.id === item.queryId) || query.length !== 1 || !query[0]!.visible || query[0]!.blockerAttribution !== "none") continue;
    facts.push({ kind: "public-description", description: item.description, basis: "native-visible-query-point", decision: decision(item.nodeId, item.revision) });
    if (facts.length >= 16) break;
  }
  return { version: 1, status: "ready", binding: { worldId: seen.worldId, sceneId: seen.sceneId, userId: seen.userId, clientId: seen.clientId, tokenId: seen.tokenId, stateRevision: seen.stateRevision, observationId: seen.id }, facts: facts as unknown as AiDmJsonValue, unknowns, sourceRevision: plan.sourceRevision };
}
