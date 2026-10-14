import { createHash } from "node:crypto";
import { z } from "zod";
import { McpError as DotMcpError, type EventDefinition } from "../../../../foundry-local-api/server/events-core.js";

export { DotMcpError };

export const DOT_PROTOCOL_VERSION = "2026-07-28";
export const DOT_EVENT_NAME = "foundry.player_turn_completed";
export const dotIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const turnPositionSchema = z.object({
  round: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  turn: z.number().int().min(0).max(255),
  combatantId: dotIdentifier,
}).strict();
export const dotFiltersSchema = z.object({
  worldId: dotIdentifier,
  sessionId: dotIdentifier,
  controllerId: dotIdentifier,
  combatId: dotIdentifier.optional(),
}).strict();
export const completedTurnDataSchema = dotFiltersSchema.required().extend({
  sceneId: dotIdentifier,
  stateRevision: sha256,
  previous: turnPositionSchema,
  next: turnPositionSchema,
}).strict();
export const completedTurnInputSchema = completedTurnDataSchema.extend({
  eventId: z.string().regex(/^turn-[a-f0-9]{64}$/),
  timestamp: z.iso.datetime({ offset: true }),
}).strict();
export const verifiedBridgeIdentitySchema = z.object({
  clientId: dotIdentifier,
  userId: dotIdentifier,
  lane: z.literal("gm"),
}).strict();
export const stateRevisionInputSchema = z.object({
  worldId: dotIdentifier, sessionId: dotIdentifier, controllerId: dotIdentifier,
  sceneId: dotIdentifier, combatId: dotIdentifier,
  combatModifiedTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  round: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  turn: z.number().int().min(0).max(255),
  combatantIds: z.array(dotIdentifier).min(1).max(256), paused: z.boolean(),
}).strict();
export type DotFilters = z.infer<typeof dotFiltersSchema>;
export type CompletedTurnData = z.infer<typeof completedTurnDataSchema>;
export type CompletedPlayerTurnInput = z.infer<typeof completedTurnInputSchema>;
export type VerifiedBridgeIdentity = z.infer<typeof verifiedBridgeIdentitySchema>;
export type DotStateRevisionInput = z.infer<typeof stateRevisionInputSchema>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
/** Mirror this exact ordered array in the browser; do not hash object property order. */
export function completedTurnEventId(data: CompletedTurnData): string {
  return `turn-${digest(["foundry-player-turn-v1", data.worldId, data.sessionId,
    data.controllerId, data.sceneId, data.combatId, data.previous.round,
    data.previous.turn, data.previous.combatantId, data.next.round, data.next.turn,
    data.next.combatantId, data.stateRevision])}`;
}
export function dotStateRevision(input: DotStateRevisionInput): string {
  const data = stateRevisionInputSchema.parse(input);
  if (data.turn >= data.combatantIds.length || new Set(data.combatantIds).size !== data.combatantIds.length)
    throw new DotMcpError(-32602, "Invalid authoritative combat order.");
  return digest(["foundry-dot-state-v1", data.worldId, data.sessionId, data.controllerId,
    data.sceneId, data.combatId, data.combatModifiedTime, data.round, data.turn,
    data.combatantIds, data.paused]);
}
export function canonicalFilters(filters: DotFilters): string {
  return JSON.stringify([filters.worldId, filters.sessionId, filters.controllerId, filters.combatId ?? null]);
}
export function matchesFilters(data: CompletedTurnData, filters: DotFilters): boolean {
  return data.worldId === filters.worldId && data.sessionId === filters.sessionId &&
    data.controllerId === filters.controllerId && (!filters.combatId || data.combatId === filters.combatId);
}
export interface DotEventEnvelope {
  eventId: string;
  name: typeof DOT_EVENT_NAME;
  timestamp: string;
  data: CompletedTurnData;
  cursor: string;
}
/** AI DM owns completed-turn semantics; the API owns transport and persistence. */
export const completedTurnDefinition: EventDefinition<DotFilters, CompletedTurnData, CompletedPlayerTurnInput, VerifiedBridgeIdentity> = {
  name: DOT_EVENT_NAME,
  description: "A verified player combatant completed a turn in the selected DM controller's combat.",
  filtersSchema: dotFiltersSchema, dataSchema: completedTurnDataSchema,
  inputSchema: completedTurnInputSchema, identitySchema: verifiedBridgeIdentitySchema,
  eventId: completedTurnEventId,
  data: input => ({ worldId: input.worldId, sessionId: input.sessionId, controllerId: input.controllerId, combatId: input.combatId, sceneId: input.sceneId, stateRevision: input.stateRevision, previous: input.previous, next: input.next }),
  canonicalFilters, matchesFilters,
  sameScope: (left, right) => left.worldId === right.worldId && left.sessionId === right.sessionId && left.controllerId === right.controllerId && (!right.combatId || left.combatId === right.combatId),
  validateOccurrence: (input, now) => {
    const occurrence = Date.parse(input.timestamp);
    return occurrence <= now + 30000 && occurrence >= now - 120000 &&
      ((input.next.round === input.previous.round && input.next.turn === input.previous.turn + 1) ||
       (input.next.round === input.previous.round + 1 && input.next.turn === 0));
  },
};
