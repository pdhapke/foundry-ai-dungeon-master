import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedContext, currentGameContext, TriggerGuard } from "./chatkit-context.js";
void describe("ChatKit context and trigger boundary (mocked Foundry)", () => {
  void it("rejects hidden/arbitrary fields and bounds the allowlist", () => {
    assert.throws(() => boundedContext({ journal: "GM secret" }), /Unsupported/);
    assert.throws(() => boundedContext({ controlledTokenIds: Array(21).fill("token") }), /20/);
    assert.throws(() => boundedContext({ sceneName: "x".repeat(201) }), /long/);
    assert.throws(() => boundedContext({ round: Number.NaN }), /combat/);
    assert.deepEqual(boundedContext({ round: -1, turn: -1 }), {});
    assert.deepEqual(
      boundedContext({ sceneId: "scene", controlledTokenIds: ["token", "token"], round: 2 }),
      { sceneId: "scene", controlledTokenIds: ["token"], round: 2 },
    );
  });
  void it("rejects player extraction and never copies document secrets", () => {
    Object.assign(globalThis, {
      game: { user: { isGM: false } },
      canvas: { scene: { id: "scene", name: "Visible", journal: "secret" } },
    });
    assert.throws(() => currentGameContext(), /GM/);
    Object.assign(globalThis, {
      game: { user: { isGM: true }, combat: { id: "combat", round: 1, turn: 0, secret: "hidden" } },
    });
    assert.deepEqual(currentGameContext(), {
      sceneId: "scene",
      sceneName: "Visible",
      controlledTokenIds: [],
      controlledActorIds: [],
      targetTokenIds: [],
      combatId: "combat",
      round: 1,
      turn: 0,
    });
  });
  void it("deduplicates request IDs, rejects overlap, releases on cancellation, and expires IDs", () => {
    const guard = new TriggerGuard();
    assert.equal(guard.start("one", 1000), true);
    assert.equal(guard.start("one", 1001), false);
    assert.throws(() => guard.start("two", 1002), /already/);
    guard.finish();
    assert.equal(guard.start("two", 1003), true);
    guard.finish();
    assert.equal(guard.start("one", 302000), true);
  });
});
