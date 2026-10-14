import type { AiDmAccessScope, AiDmContextActivation, AiDmContextDependency, AiDmVisibility } from "./ai-dungeon-master.js";

/** Internal authorization/provenance. Never render these identifiers as narration. */
export interface PlayerObservationBinding {
  worldId: string;
  sceneId: string;
  userId: string;
  clientId: string;
  tokenId: string;
  stateRevision: string;
  observationId: string;
}

/** Server health and GM connectivity cannot satisfy this contract. */
export type PlayerPerceptionReadiness =
  | { status: "ready"; binding: PlayerObservationBinding }
  | { status: "NOT_CONNECTED" | "stale" | "unsupported" | "incomplete"; retryable: boolean; binding: null };

/** Reuses campaign visibility and activation instead of adding another campaign store. */
export interface PlayerRevealDecision {
  visibility: Extract<AiDmVisibility, "public" | "player">;
  audience: AiDmAccessScope;
  activation: AiDmContextActivation;
  dependencies: AiDmContextDependency[];
  policyRevision: string;
}

export interface PlayerObservableFact {
  kind: "area-visible" | "visible-barrier" | "visible-door" | "public-description" | "threat-noticed" | "observer-noticed-player" | "trap-triggered";
  description: string;
  basis: "native-observation" | "native-visible-barrier" | "native-visible-query-point" | "authorized-reveal" | "confirmed-result";
  decision: PlayerRevealDecision;
}

/** Private rationale, document IDs, coordinates and labels have no public field. */
export interface PlayerObservableResult {
  version: 1;
  binding: PlayerObservationBinding;
  facts: PlayerObservableFact[];
  unknowns: Array<"area" | "unobserved-area" | "threat" | "being-noticed" | "trap">;
}
