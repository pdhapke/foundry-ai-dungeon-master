import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DurableNativePreparationComposer, type NativeStepReceipt } from "./durable-native.js";
import type { NativePreparationReviewPackage } from "./native-adapter.js";
const caller = { worldId: "world", isGm: true };
function fixture() {
  const db = new DatabaseSync(":memory:"); let fresh = true, active = false, calls = 0, fail = false;
  const receipts = new Map<string, NativeStepReceipt>();
  const pkg = { id: "a".repeat(64), digest: "digest", worldId: "world", state: "reviewed", sourceRevisions: { source: "rev" },
    sceneRequest: { args: { data: { active: false, navigation: false, tokens: [{ actorId: "actor", actorLink: false }] } } } } as unknown as NativePreparationReviewPackage;
  const authority = { authorize: () => {}, assertPrivateStorage: () => {}, currentSourceRevisions: () => ({ source: fresh ? "rev" : "other" }),
    authorizeHumanReview: (approval: string, digest: string) => { if (approval !== "human" || digest !== pkg.digest) throw new Error("denied"); } };
  const composer = new DurableNativePreparationComposer(db, authority, {
    recover: async (step) => receipts.get(step.id),
    apply: async (step) => {
      calls++; const receipt = { verified: true, worldId: "world", targetId: calls === 1 ? "scene" : "token", revision: "rev", receiptId: step.id };
      receipts.set(step.id, receipt);
      if (fail && calls === 2) throw new Error("interrupted after write");
      return receipt;
    },
    inspectScene: async () => ({ worldId: "world", active, revision: "rev", preparationId: pkg.id }),
  });
  return { composer, pkg, calls: () => calls, stale: () => { fresh = false; }, activate: () => { active = true; }, interrupt: () => { fail = true; } };
}
test("staged composition replays receipts and recovers interrupted embedded write", async () => {
  const f = fixture(); f.interrupt();
  await assert.rejects(f.composer.compose(caller, f.pkg, "human"), /interrupted/);
  assert.equal(f.composer.status(caller, f.pkg.id)?.state, "partial");
  const result = await f.composer.compose(caller, f.pkg, "human");
  assert.equal(result.state, "complete"); assert.equal(f.calls(), 2);
  await f.composer.compose(caller, f.pkg, "human"); assert.equal(f.calls(), 2);
  assert.equal(result.readiness.liveAccepted, false); assert.equal(result.readiness.visibility, false);
});
test("review, world, source and inactive gates fail closed", async () => {
  const f = fixture();
  await assert.rejects(f.composer.compose(caller, f.pkg, "model"), /denied/);
  await assert.rejects(f.composer.compose({ ...caller, worldId: "other" }, f.pkg, "human"), /unavailable/);
  f.stale(); await assert.rejects(f.composer.compose(caller, f.pkg, "human"), /Stale/); assert.equal(f.calls(), 0);
  const a = fixture(); a.activate(); await assert.rejects(a.composer.compose(caller, a.pkg, "human"), /active/);
  assert.equal(a.calls(), 1);
});
test("concurrent composition obtains one durable claim", async () => {
  const f = fixture(); const results = await Promise.allSettled([f.composer.compose(caller, f.pkg, "human"), f.composer.compose(caller, f.pkg, "human")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.calls(), 2);
});
