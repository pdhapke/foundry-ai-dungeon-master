import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChatCommand, parseCoreCommand } from "./core-command.js";

void test("Foundry14 serialized editor commands preserve explicit typed targets", () => {
  const command = normalizeChatCommand("<p>/ai-control&nbsp;door scene door open</p>");
  assert.equal(command, "/ai-control door scene door open");
  assert.deepEqual(parseCoreCommand(command.slice("/ai-control ".length)), { kind: "door.state", sceneId: "scene", targetId: "door", value: 1 });
  assert.equal(normalizeChatCommand("<p>&#47;ai resume the game</p>"), "/ai resume the game");
  assert.equal(normalizeChatCommand("/ai-control roll 1d20"), "/ai-control roll 1d20");
  for (const html of ["<p><script>/ai-control roll 1d20</script></p>", "<p onclick='execute()'>/ai-control roll 1d20</p>", "<p>/ai-control roll 1d20</p><p>extra</p>"]) assert.equal(normalizeChatCommand(html), html);
});

void test("explicit attack shortcuts preserve native IDs and never accept model reaction waiver", () => {
  assert.deepEqual(parseCoreCommand("attack scene attacker actor item activity target disadvantage"), { mode: "roll", sceneId: "scene", attackerTokenId: "attacker", actorId: "actor", itemId: "item", activityId: "activity", targetTokenId: "target", advantage: "disadvantage" });
  assert.deepEqual(parseCoreCommand("attack-apply receipt-one"), { mode: "apply", priorAttackRequestId: "receipt-one" });
  assert.throws(() => parseCoreCommand("attack-apply receipt-one ticket"), /arguments/);
  assert.throws(() => parseCoreCommand("attack scene attacker actor item activity target waived"), /advantage/);
  assert.deepEqual(parseCoreCommand("teleport scene token 100 200"), { kind: "token.position", sceneId: "scene", targetId: "token", x: 100, y: 200, mode: "teleport" });
});
