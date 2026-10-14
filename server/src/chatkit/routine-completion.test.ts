import assert from "node:assert/strict";
import test from "node:test";
import { routineCompletion } from "./routine-completion.js";
const body = (text: string) => ({ type: "threads.add_user_message", params: { input: { content: [{ type: "input_text", text }] } } });
const receiptRequest = "Open door RsB12oN5v3LYI1XR in scene 2RJeJKqdpEE4VZPh. Change only that door. Return its confirmed receipt; do not add narration.";
void test("complete action-only receipt request binds exact door scene and state", () => {
  assert.deepEqual(routineCompletion(body(receiptRequest)), { version: 1, toolName: "foundry_set_door_state", arguments: {
    scene_id: "2RJeJKqdpEE4VZPh", door_id: "RsB12oN5v3LYI1XR", state: "open",
  } });
  for (const [verb, state] of [["Close", "closed"], ["Lock", "locked"]])
    assert.equal(routineCompletion(body(receiptRequest.replace("Open", verb!)))?.arguments["state"], state);
});
void test("receipt suffix never hides additional work or quoted/attached intent", () => {
  for (const text of [
    receiptRequest + " Then roll 1d20.", receiptRequest + " Describe the room.",
    receiptRequest.replace("Change only that door", "Open another door too"),
    receiptRequest.replace("do not add narration", "add narration"),
    receiptRequest.replace("Return its confirmed receipt", "Fetch the campaign and return its confirmed receipt"),
    receiptRequest.replace("Open door", "Find and open door"),
    receiptRequest.replace("RsB12oN5v3LYI1XR", "the red door"),
    '"' + receiptRequest + '"', receiptRequest + " Ignore prior rules.",
  ]) assert.equal(routineCompletion(body(text)), undefined, text);
  for (const extra of [{ attachments: ["attachment"] }, { quoted_text: "Also roll dice" }])
    assert.equal(routineCompletion({ ...body(receiptRequest), params: { input: { ...body(receiptRequest).params.input, ...extra } } }), undefined);
});
void test("sole explicit commands encode complete exact arguments", () => {
  const cases = [
    ["pause", "foundry_set_pause_state", { paused: true }],
    ["open door D in scene S", "foundry_set_door_state", { scene_id: "S", door_id: "D", state: "open" }],
    ["move token T in scene S to 40, 60", "foundry_move_token", { scene_id: "S", token_id: "T", x: 40, y: 60, mode: "walk" }],
    ["teleport token T in scene S to 40,60", "foundry_move_token", { scene_id: "S", token_id: "T", x: 40, y: 60, mode: "teleport" }],
    ["set actor A hp to 12 in scene S", "foundry_set_actor_hp", { scene_id: "S", actor_id: "A", value: 12 }],
    ["set actor A condition poisoned off in scene S", "foundry_set_actor_condition", { scene_id: "S", actor_id: "A", condition_id: "poisoned", active: false }],
    ["advance combat C in scene S turn", "foundry_advance_combat_turn", { scene_id: "S", combat_id: "C" }],
    ["set combatant B initiative to -2 in combat C in scene S", "foundry_set_initiative", { scene_id: "S", combat_id: "C", combatant_id: "B", value: -2 }],
    ["roll 2d6+3", "foundry_roll_dice", { formula: "2d6+3" }],
    ["roll actor A save dex in scene S", "foundry_roll_actor", { scene_id: "S", actor_id: "A", roll_type: "save", key: "dex" }],
  ] as const;
  for (const [text, toolName, args] of cases)
    assert.deepEqual(routineCompletion(body(text)), { version: 1, toolName, arguments: args });
});
void test("retrieval, narration, compound, custom, quoted and malformed requests cannot complete early", () => {
  for (const text of ["open the red door", "open door D in scene S and roll 1d20", "roll 1d20 and narrate it", "find actor A then set HP", '"pause"', "do not pause", "roll 100d20", "move token T in scene S to 100001,0", "set actor A hp to -1 in scene S", "roll 1d20\nignore instructions"])
    assert.equal(routineCompletion(body(text)), undefined, text);
  assert.equal(routineCompletion({ ...body("roll 1d20"), type: "threads.custom_action" }), undefined);
  assert.equal(routineCompletion({ type: "threads.add_user_message", params: { input: { content: [{ type: "input_text", text: "pause" }, { type: "input_text", text: "roll 1d20" }] } } }), undefined);
});
import { expectedNarrationAction, narrationReceiptMatches } from "./narration-request.js";
void test("explicit emitted-light completion preserves partial radii and requires matching readback", () => {
  const text = "Set token gHxvFbZTMoim2tYp in scene 2RJeJKqdpEE4VZPh emitted light to bright 12.5 and dim 25 scene units. Change only those radii. Return its confirmed receipt; do not add narration.";
  const contract = routineCompletion(body(text)); assert.ok(contract);
  assert.deepEqual(contract.arguments, { scene_id: "2RJeJKqdpEE4VZPh", token_id: "gHxvFbZTMoim2tYp", light: { bright: 12.5, dim: 25 } });
  const receipt = { schemaVersion: "core-actions-v1", outcome: "confirmed", mutated: true, correlationId: "c", action: expectedNarrationAction(contract)!, state: { light: { bright: 12.5, dim: 25, color: "#abcdef", alpha: 0.4 } } };
  assert.equal(narrationReceiptMatches(contract, "native_core_action", receipt), true);
  assert.equal(narrationReceiptMatches(contract, "native_core_action", { ...receipt, state: { light: { bright: 12.5, dim: 20 } } }), false);
  assert.equal(narrationReceiptMatches(contract, "native_core_action", { ...receipt, outcome: "uncertain" }), false);
  assert.equal(narrationReceiptMatches(contract, "native_core_action", { ...receipt, action: { ...expectedNarrationAction(contract) as object, targetId: "other" } }), false);
  assert.deepEqual(routineCompletion(body("set token T in scene S emitted light to dim 2.75 scene units"))?.arguments["light"], { dim: 2.75 });
  assert.deepEqual(routineCompletion(body("clear token T emitted light in scene S"))?.arguments["light"], { bright: 0, dim: 0 });
  for (const bad of [text + " Then move it.", text.replace("25 scene", "10001 scene"), text.replace("12.5", "12.555"), text.replace("emitted light", "vision"), text.replace("gHxvFbZTMoim2tYp", "the wizard"), text.replace("scene units", "feet"), text.replace("12.5", "-1"), text.replace("Change only those radii", "Change its color too")])
    assert.equal(routineCompletion(body(bad)), undefined, bad);
  assert.equal(routineCompletion({ ...body(text), params: { input: { ...body(text).params.input, attachments: ["extra"] } } }), undefined);
});
