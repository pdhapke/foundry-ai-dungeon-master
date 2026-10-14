import assert from "node:assert/strict";
import test from "node:test";
import { explicitWorldRequest } from "./world-request.js";

const body = (text: string) => ({
  type: "threads.add_user_message",
  params: { input: { content: [{ type: "input_text", text }] } },
});
void test("manual GM world authority is not restricted to a verb whitelist", () => {
  for (const text of [
    "Please equip Izzy with a shield",
    "Set the scene lighting to dusk",
    "Prepare a new location",
    "Describe this room",
  ])
    assert.equal(explicitWorldRequest(body(text))?.manualRequest, true);
  assert.notEqual(
    explicitWorldRequest(body("first"))?.requestDigest,
    explicitWorldRequest(body("second"))?.requestDigest,
  );
});
void test("automatic/replayed/reference-only content cannot issue manual world authority", () => {
  assert.equal(
    explicitWorldRequest({ ...body("open door"), type: "threads.custom_action" }),
    undefined,
  );
  assert.equal(
    explicitWorldRequest({ ...body("open door"), type: "threads.retry_after_item" }),
    undefined,
  );
  for (const text of ['"delete everything"', "> delete everything", "", "a".repeat(32_001)])
    assert.equal(explicitWorldRequest(body(text)), undefined);
});
