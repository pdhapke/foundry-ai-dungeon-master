import assert from "node:assert/strict";
import test from "node:test";
import {
  completedPlayerTurn,
  snapshotCombatTurn,
  type CombatTurnDocument,
} from "./completed-player-turn.js";

const combat = (overrides: Partial<CombatTurnDocument> = {}): CombatTurnDocument => ({
  id: "combat",
  scene: "scene",
  active: true,
  round: 1,
  turn: 0,
  turns: [{ id: "player", actor: { hasPlayerOwner: true } }, { id: "npc" }],
  _stats: { modifiedTime: 10 },
  ...overrides,
});

void test("completed player turn preserves the existing automatic signal and structured positions", () => {
  const previous = snapshotCombatTurn(combat());
  const event = completedPlayerTurn("world", combat({ turn: 1 }), previous)!;
  assert.deepEqual(event, {
    signal: {
      kind: "turn",
      worldId: "world",
      sceneId: "scene",
      documentId: "combat",
      revision: 10,
      transition: '[1,0,"player",1,1,"npc"]',
    },
    previous: { round: 1, turn: 0, combatantId: "player" },
    next: { round: 1, turn: 1, combatantId: "npc" },
  });
});

void test("last player wraps into the next round, including single-combatant combats", () => {
  const turns = [{ id: "npc" }, { id: "player", actor: { hasPlayerOwner: true } }];
  const previous = snapshotCombatTurn(combat({ turns, turn: 1 }));
  assert.ok(completedPlayerTurn("world", combat({ turns, round: 2, turn: 0 }), previous));
  const solo = combat({ turns: [turns[1]!] });
  assert.ok(completedPlayerTurn("world", { ...solo, round: 2 }, snapshotCombatTurn(solo)));
});

void test("baseline, NPC, edits, backward/skipped turns, reorder, and inactive combat are not completion", () => {
  const previous = snapshotCombatTurn(combat());
  assert.equal(completedPlayerTurn("world", combat({ turn: 1 }), undefined), undefined);
  for (const next of [
    combat(),
    combat({ round: 3, turn: 1 }),
    combat({ round: 2, turn: 0 }),
    combat({ turn: -1 }),
    combat({ turn: 0.5 }),
    combat({ active: false, turn: 1 }),
    combat({ scene: "", turn: 1 }),
    combat({ turns: [{ id: "other" }, { id: "player" }], turn: 1 }),
  ]) {
    assert.equal(completedPlayerTurn("world", next, previous), undefined);
  }
  const npc = snapshotCombatTurn(combat({ turn: 1 }));
  assert.equal(completedPlayerTurn("world", combat({ round: 2 }), npc), undefined);
  const lastPlayer = snapshotCombatTurn(
    combat({ turns: [{ id: "a" }, { id: "b", actor: { hasPlayerOwner: true } }], turn: 1 }),
  );
  assert.equal(completedPlayerTurn("world", combat({ turn: 0 }), lastPlayer), undefined);
});

void test("DM-caused and all existing structured bridge-origin phases suppress feedback", () => {
  const previous = snapshotCombatTurn(combat());
  for (const source of [
    "foundry-local-api.transaction",
    "foundry-local-api.session-action",
    "foundry-local-api.world-document",
  ]) {
    for (const phase of ["apply", "compensate"]) {
      assert.equal(
        completedPlayerTurn("world", combat({ turn: 1 }), previous, {
          bridgeOrigin: { source, phase, correlationId: "operation-one" },
        }),
        undefined,
      );
    }
  }
  assert.equal(
    completedPlayerTurn("world", combat({ turn: 1 }), previous, { dmCaused: true }),
    undefined,
  );
  assert.ok(completedPlayerTurn("world", combat({ turn: 1 }), previous, { bridgeOrigin: "ai" }));
});

void test("extraction leaves inputs intact and accepts a scene document reference", () => {
  const previous = Object.freeze(snapshotCombatTurn(combat()));
  const next = Object.freeze(combat({ turn: 1, scene: { id: "scene" } }));
  assert.equal(completedPlayerTurn("world", next, previous)?.signal.sceneId, "scene");
  assert.equal(previous.turn, 0);
  assert.equal(next.turn, 1);
});
