import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatCommand, parseCoreCommand } from "./core-command.js";

void test("independent Foundry paragraph normalization preserves plain control grammar and rejects rich envelopes", () => {
  const plain = "/ai-control door scene_id door_id closed";
  assert.equal(normalizeChatCommand(plain), plain);
  assert.equal(normalizeChatCommand(`<p>${plain}</p>`), plain);
  assert.equal(normalizeChatCommand("<p>&#x2f;ai-control&nbsp;door scene_id door_id closed<br/></p>"), plain);
  assert.deepEqual(parseCoreCommand(normalizeChatCommand(`<p>${plain}</p>`).slice(12)), { kind: "door.state", sceneId: "scene_id", targetId: "door_id", value: 0 });
  for (const rich of [`<p style="color:red">${plain}</p>`, `<p><a href="x">${plain}</a></p>`, `<div>${plain}</div>`, `<p>${plain}</p><p>other</p>`, `<p>${plain}<img src=x onerror=x></p>`]) {
    assert.equal(normalizeChatCommand(rich), rich);
    assert.ok(!normalizeChatCommand(rich).startsWith("/ai-control "));
  }
  assert.throws(() => parseCoreCommand("door scene_id door_id closed extra"));
  assert.throws(() => parseCoreCommand("door scene_id door_id toggle"));
});
