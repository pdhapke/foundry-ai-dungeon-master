import { isBridgeMutation, type AutomaticSignal } from "./automatic-triggers.js";

export interface TurnPosition {
  round: number;
  turn: number;
  combatantId: string;
}

export interface CombatTurnDocument {
  id: string;
  scene?: { id: string } | string;
  active?: boolean;
  round?: number;
  turn?: number;
  turns?: ReadonlyArray<{ id: string; actor?: { hasPlayerOwner?: boolean } }>;
  _stats?: { modifiedTime?: number };
}

export interface CombatTurnSnapshot extends TurnPosition {
  player: boolean;
  order: string;
}

export interface CompletedPlayerTurn {
  signal: AutomaticSignal & { kind: "turn" };
  previous: TurnPosition;
  next: TurnPosition;
}

export function snapshotCombatTurn(combat: CombatTurnDocument): CombatTurnSnapshot {
  return {
    round: combat.round ?? 0,
    turn: combat.turn ?? -1,
    combatantId: combat.turns?.[combat.turn ?? -1]?.id ?? "",
    player: combat.turns?.[combat.turn ?? -1]?.actor?.hasPlayerOwner === true,
    order: JSON.stringify((combat.turns ?? []).map((turn) => turn.id)),
  };
}

/** Pure extraction of the hook's forward-transition rule; never reads chat or mutates Foundry. */
export function completedPlayerTurn(
  worldId: string,
  combat: CombatTurnDocument,
  previous: CombatTurnSnapshot | undefined,
  options: { bridgeOrigin?: unknown; dmCaused?: boolean } = {},
): CompletedPlayerTurn | undefined {
  const next = snapshotCombatTurn(combat);
  const sceneId = typeof combat.scene === "string" ? combat.scene : combat.scene?.id;
  if (
    !worldId ||
    !previous ||
    !sceneId ||
    combat.active !== true ||
    !previous.player ||
    !Number.isSafeInteger(previous.round) ||
    previous.round < 1 ||
    !Number.isSafeInteger(previous.turn) ||
    previous.turn < 0 ||
    !Number.isSafeInteger(next.round) ||
    !Number.isSafeInteger(next.turn) ||
    next.turn < 0 ||
    !next.combatantId ||
    next.order !== previous.order ||
    options.dmCaused === true ||
    isBridgeMutation(options.bridgeOrigin)
  )
    return;
  const forward =
    (next.round === previous.round && next.turn === previous.turn + 1) ||
    (next.round === previous.round + 1 &&
      previous.turn === (combat.turns?.length ?? 0) - 1 &&
      next.turn === 0);
  if (!forward) return;
  const before: TurnPosition = {
    round: previous.round,
    turn: previous.turn,
    combatantId: previous.combatantId,
  };
  const after: TurnPosition = {
    round: next.round,
    turn: next.turn,
    combatantId: next.combatantId,
  };
  return {
    signal: {
      kind: "turn",
      worldId,
      sceneId,
      documentId: combat.id,
      revision: combat._stats?.modifiedTime ?? -1,
      transition: JSON.stringify([
        before.round,
        before.turn,
        before.combatantId,
        after.round,
        after.turn,
        after.combatantId,
      ]),
    },
    previous: before,
    next: after,
  };
}
