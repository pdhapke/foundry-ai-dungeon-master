import assert from "node:assert/strict";
import test from "node:test";
import { completedTurnEventId, dotStateRevision, type CompletedTurnData, type DotStateRevisionInput } from "./contract.js";

void test("DM revision and completed-turn IDs are stable across object order and sensitive to controller, state and turn", () => {
  const state: DotStateRevisionInput = { worldId: "world", sessionId: "session", controllerId: "controller", sceneId: "scene", combatId: "combat", combatModifiedTime: 1, round: 1, turn: 1, combatantIds: ["player", "monster"], paused: false };
  const revision = dotStateRevision(state);
  assert.equal(dotStateRevision(Object.fromEntries(Object.entries(state).reverse()) as unknown as DotStateRevisionInput), revision);
  for (const change of [{ controllerId: "other" }, { sessionId: "other" }, { combatModifiedTime: 2 }, { paused: true }, { combatantIds: ["monster", "player"] }]) assert.notEqual(dotStateRevision({ ...state, ...change }), revision);
  const input: CompletedTurnData = { worldId: state.worldId, sessionId: state.sessionId, controllerId: state.controllerId, sceneId: state.sceneId, combatId: state.combatId, stateRevision: revision, previous: { round: 1, turn: 0, combatantId: "player" }, next: { round: 1, turn: 1, combatantId: "monster" } };
  const id = completedTurnEventId(input);
  assert.equal(completedTurnEventId(Object.fromEntries(Object.entries(input).reverse()) as unknown as CompletedTurnData), id);
  assert.notEqual(completedTurnEventId({ ...input, controllerId: "other" }), id);
  assert.notEqual(completedTurnEventId({ ...input, next: { ...input.next, round: 2 } }), id);
});
