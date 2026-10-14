import { isBridgeMutation, type AutomaticSignal } from "./automatic-triggers.js";
import type { CompletedPlayerTurn, TurnPosition } from "./completed-player-turn.js";

export type DmEventMode = "embedded" | "dot";

/** Binding supplied by the verified GM bridge, not by event payloads or MCP callers. */
export interface DmControllerScope {
  worldId: string;
  sessionId: string;
  controllerId: string;
  sceneId: string;
  connected: boolean;
  isController: boolean;
  automaticEventsEnabled: boolean;
}

/** Exact v1 projection in foundry-local-api/docs/dot-mcp-events.md. */
export interface DotTurnState {
  worldId: string;
  sessionId: string;
  controllerId: string;
  sceneId: string;
  combatId: string;
  combatModifiedTime: number;
  round: number;
  turn: number;
  combatantIds: readonly string[];
  paused: boolean;
}

export interface CompletedPlayerTurnInput {
  eventId: `turn-${string}`;
  timestamp: string;
  worldId: string;
  sessionId: string;
  controllerId: string;
  sceneId: string;
  combatId: string;
  stateRevision: string;
  previous: TurnPosition;
  next: TurnPosition;
}

const id = /^[A-Za-z0-9_-]{1,128}$/;
const isId = (value: unknown): value is string => typeof value === "string" && id.test(value);
const digest = /^[a-f0-9]{64}$/;
const validPosition = (position: TurnPosition) =>
  Number.isSafeInteger(position.round) &&
  position.round >= 1 &&
  Number.isSafeInteger(position.turn) &&
  position.turn >= 0 &&
  position.turn <= 255 &&
  isId(position.combatantId);

export function canonicalDotTurnState(state: DotTurnState): string {
  if (
    ![state.worldId, state.sessionId, state.controllerId, state.sceneId, state.combatId].every(
      isId,
    ) ||
    !Number.isSafeInteger(state.combatModifiedTime) ||
    state.combatModifiedTime < 0 ||
    !Number.isSafeInteger(state.round) ||
    state.round < 1 ||
    !Number.isSafeInteger(state.turn) ||
    state.turn < 0 ||
    !Array.isArray(state.combatantIds) ||
    state.combatantIds.length > 256 ||
    state.turn >= state.combatantIds.length ||
    !state.combatantIds.every(isId) ||
    new Set(state.combatantIds).size !== state.combatantIds.length ||
    typeof state.paused !== "boolean"
  )
    throw new Error("Incomplete current dot turn state.");
  return JSON.stringify([
    "foundry-dot-state-v1",
    state.worldId,
    state.sessionId,
    state.controllerId,
    state.sceneId,
    state.combatId,
    state.combatModifiedTime,
    state.round,
    state.turn,
    state.combatantIds,
    state.paused,
  ]);
}

const sha256 = async (canonical: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const dotTurnStateRevision = (state: DotTurnState): Promise<string> =>
  sha256(canonicalDotTurnState(state));

export async function completedTurnEventId(
  input: Omit<CompletedPlayerTurnInput, "eventId" | "timestamp">,
): Promise<`turn-${string}`> {
  if (
    ![input.worldId, input.sessionId, input.controllerId, input.sceneId, input.combatId].every(
      isId,
    ) ||
    !digest.test(input.stateRevision) ||
    !validPosition(input.previous) ||
    !validPosition(input.next)
  )
    throw new Error("Invalid completed player turn identity.");
  return `turn-${await sha256(
    JSON.stringify([
      "foundry-player-turn-v1",
      input.worldId,
      input.sessionId,
      input.controllerId,
      input.sceneId,
      input.combatId,
      input.previous.round,
      input.previous.turn,
      input.previous.combatantId,
      input.next.round,
      input.next.turn,
      input.next.combatantId,
      input.stateRevision,
    ]),
  )}`;
}

export interface DmEventAdapterDependencies {
  /** Missing mode preserves embedded behavior; unknown values fail closed. */
  mode?: () => unknown;
  embedded: (signal: AutomaticSignal) => void;
  scope: () => DmControllerScope | undefined;
  /** Read authoritative current state on every observation and immediately before handoff. */
  currentState: (turn: CompletedPlayerTurn) => DotTurnState | undefined;
  /** Authenticated bridge seam only. No clientId/userId/lane are supplied in this payload. */
  submit: (input: CompletedPlayerTurnInput, cancellation: AbortSignal) => Promise<void>;
  now?: () => Date;
}

export type DmEventRouteResult =
  | { status: "embedded" | "submitted" | "duplicate" | "suppressed" | "capacity" }
  | { status: "failed"; error: unknown };

/**
 * Hooks inject the authenticated bridge binding and acknowledged ingress.
 * No queue, retry timer, delivery cursor, webhook subscription, or embedded fallback.
 * Server eventService owns durable dedupe, acknowledged cursor advancement and replay.
 */
export class DmEventAdapter {
  private readonly seen = new Map<
    string,
    { status: "pending" | "finished"; mode: DmEventMode; observation: string }
  >();
  private cancellation = new AbortController();
  constructor(
    private readonly dependencies: DmEventAdapterDependencies,
    private readonly maximum = 256,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid dedupe capacity.");
  }

  /** Invoke on mode/session/scene/world/disconnect lifecycle changes. Does not retract an accepted event. */
  cancel(): void {
    this.cancellation.abort();
    this.cancellation = new AbortController();
  }

  private mode(): unknown {
    return this.dependencies.mode ? this.dependencies.mode() : "embedded";
  }

  private authorized(
    scope: DmControllerScope | undefined,
    turn: CompletedPlayerTurn,
  ): scope is DmControllerScope {
    return (
      !!scope &&
      scope.connected === true &&
      scope.isController === true &&
      scope.automaticEventsEnabled === true &&
      [scope.worldId, scope.sessionId, scope.controllerId, scope.sceneId].every(isId) &&
      scope.worldId === turn.signal.worldId &&
      scope.sceneId === turn.signal.sceneId
    );
  }

  private matches(
    state: DotTurnState | undefined,
    scope: DmControllerScope,
    turn: CompletedPlayerTurn,
  ): state is DotTurnState {
    return (
      !!state &&
      state.worldId === scope.worldId &&
      state.sessionId === scope.sessionId &&
      state.controllerId === scope.controllerId &&
      state.sceneId === scope.sceneId &&
      state.combatId === turn.signal.documentId &&
      state.combatModifiedTime === turn.signal.revision &&
      state.round === turn.next.round &&
      state.turn === turn.next.turn &&
      validPosition(turn.previous) &&
      validPosition(turn.next) &&
      state.combatantIds[state.turn] === turn.next.combatantId &&
      state.combatantIds[turn.previous.turn] === turn.previous.combatantId &&
      ((turn.next.round === turn.previous.round && turn.next.turn === turn.previous.turn + 1) ||
        (turn.next.round === turn.previous.round + 1 &&
          turn.previous.turn === state.combatantIds.length - 1 &&
          turn.next.turn === 0))
    );
  }

  async accept(turn: CompletedPlayerTurn): Promise<DmEventRouteResult> {
    if (turn.signal.kind !== "turn" || isBridgeMutation(turn.signal.bridgeOrigin))
      return { status: "suppressed" };
    turn = { signal: { ...turn.signal }, previous: { ...turn.previous }, next: { ...turn.next } };
    const mode = this.mode();
    if (mode !== "embedded" && mode !== "dot") return { status: "suppressed" };
    const observation = JSON.stringify([
      turn.signal.worldId,
      turn.signal.sceneId,
      turn.signal.documentId,
      turn.signal.revision,
      turn.signal.transition,
    ]);
    // A deliberate mode switch cannot hand the same physical observation to
    // another controller. New sessions in dot mode retain their own identity.
    if (
      [...this.seen.values()].some(
        (entry) => entry.observation === observation && entry.mode !== mode,
      )
    )
      return { status: "duplicate" };
    if (mode === "embedded") {
      const key = `embedded:${observation}`;
      if (this.seen.has(key)) return { status: "duplicate" };
      if (!this.reserve(key, mode, observation)) return { status: "capacity" };
      try {
        this.dependencies.embedded(turn.signal);
        return { status: "embedded" };
      } catch (error) {
        return { status: "failed", error };
      } finally {
        this.seen.set(key, { status: "finished", mode, observation });
      }
    }
    const binding = this.dependencies.scope();
    if (!this.authorized(binding, turn)) return { status: "suppressed" };
    const scope = { ...binding };
    const key = JSON.stringify([
      scope.worldId,
      scope.sessionId,
      scope.controllerId,
      scope.sceneId,
      turn.signal.documentId,
      turn.signal.revision,
      turn.signal.transition,
    ]);
    if (this.seen.has(key)) return { status: "duplicate" };
    if (!this.reserve(key, mode, observation)) return { status: "capacity" };
    const cancellation = this.cancellation.signal;
    let handedOff = false;
    try {
      const timestamp = (this.dependencies.now?.() ?? new Date()).toISOString();
      const state = this.dependencies.currentState(turn);
      if (!this.matches(state, scope, turn)) return { status: "suppressed" };
      const canonical = canonicalDotTurnState(state);
      const stateRevision = await sha256(canonical);
      const identity = {
        worldId: scope.worldId,
        sessionId: scope.sessionId,
        controllerId: scope.controllerId,
        sceneId: scope.sceneId,
        combatId: turn.signal.documentId,
        stateRevision,
        previous: { ...turn.previous },
        next: { ...turn.next },
      };
      const eventId = await completedTurnEventId(identity);
      const currentScope = this.dependencies.scope();
      if (
        cancellation.aborted ||
        this.mode() !== "dot" ||
        !this.authorized(currentScope, turn) ||
        currentScope.sessionId !== scope.sessionId ||
        currentScope.controllerId !== scope.controllerId
      )
        return { status: "suppressed" };
      const currentState = this.dependencies.currentState(turn);
      if (
        !this.matches(currentState, currentScope, turn) ||
        canonicalDotTurnState(currentState) !== canonical
      )
        return { status: "suppressed" };
      handedOff = true;
      await this.dependencies.submit({ ...identity, eventId, timestamp }, cancellation);
      return { status: "submitted" };
    } catch (error) {
      return { status: "failed", error };
    } finally {
      // An uncertain bridge write stays seen. Explicit server reconciliation may
      // retry this stable ID; this adapter never replays or starts inference twice.
      if (handedOff) this.seen.set(key, { status: "finished", mode, observation });
      else this.seen.delete(key);
    }
  }

  private reserve(key: string, mode: DmEventMode, observation: string): boolean {
    if (this.seen.size >= this.maximum) {
      const completed = [...this.seen].find(([, entry]) => entry.status === "finished");
      if (!completed) return false;
      this.seen.delete(completed[0]);
    }
    this.seen.set(key, { status: "pending", mode, observation });
    return true;
  }
}
