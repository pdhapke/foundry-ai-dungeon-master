import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEWED_WORLD_TOOLS,
  WORLD_DOCUMENT_FAMILIES,
  worldToolDisposition,
  sensitiveDocumentChange,
} from "./world-tool-policy.js";
void test("every supported world family has explicit list/get/create/update/delete and separate readback", () => {
  assert.equal(WORLD_DOCUMENT_FAMILIES.length, 21);
  assert.equal(REVIEWED_WORLD_TOOLS.size, 105);
  for (const family of WORLD_DOCUMENT_FAMILIES) {
    const policies = [...REVIEWED_WORLD_TOOLS.values()].filter((p) => p.family === family);
    assert.equal(policies.length, 5);
    for (const p of policies) {
      assert.equal(p.readBackTool, `foundry_get_${family.singular}`);
      assert.equal(p.destructive, p.operation === "delete");
      assert.ok(worldToolDisposition(p.toolId).reason);
    }
  }
});
void test("unknown administration/code/specialized tools have named reasons and cannot become reviewed by annotation", () => {
  for (const tool of [
    "foundry_execute_script",
    "foundry_set_setting",
    "unknown_raw_mutation",
    "foundry_deal_cards",
  ]) {
    assert.equal(REVIEWED_WORLD_TOOLS.has(tool), false);
    assert.ok(worldToolDisposition(tool).reason.includes(tool));
  }
  assert.equal(worldToolDisposition("foundry_execute_script").disposition, "separate-code-review");
  assert.equal(worldToolDisposition("foundry_set_setting").disposition, "separate-administration");
  assert.equal(sensitiveDocumentChange({ "ownership.default": 3 }), true);
  assert.equal(sensitiveDocumentChange({ name: "new NPC" }), false);
});

