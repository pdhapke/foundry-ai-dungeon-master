import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateWorldReview, type WorldReview } from "./world-review.js";
const scope = { worldId: "world", userId: "gm", threadId: "thread" };
const sorted = (value: unknown): unknown =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(sorted)
      : Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, sorted(v)]),
        )
    : value;
function fixture(kind: WorldReview["kind"]): WorldReview {
  const request = { operation: "delete", targetId: "actor", path: "notes/test.md" };
  const before = { targetId: "actor", source: { name: "Example" } };
  const reviewDigest = createHash("sha256")
    .update(
      JSON.stringify(
        sorted({
          scope,
          input: request,
          before,
          selectedTarget: kind === "world" ? before.targetId : request.path,
        }),
      ),
    )
    .digest("hex");
  return {
    kind,
    scope,
    actionId: "action",
    request,
    before,
    reviewDigest,
    status: "pending",
    receipt: null,
    requiresConfirmation: true,
    reviewComplete: true,
  };
}
void test("destructive world and file reviews bind exact target, content and identity", async () => {
  for (const kind of ["world", "world-file"] as const) {
    const review = fixture(kind);
    assert.equal((await validateWorldReview(review, scope)).actionId, "action");
    await assert.rejects(validateWorldReview(review, { ...scope, worldId: "elsewhere" }));
    await assert.rejects(validateWorldReview({ ...review, reviewComplete: false }, scope));
    await assert.rejects(
      validateWorldReview(
        { ...review, request: { ...review.request, targetId: "different" } },
        scope,
      ),
      /changed/,
    );
    await assert.rejects(
      validateWorldReview(
        { ...review, before: { ...review.before, source: { name: "altered" } } },
        scope,
      ),
      /changed/,
    );
  }
});
