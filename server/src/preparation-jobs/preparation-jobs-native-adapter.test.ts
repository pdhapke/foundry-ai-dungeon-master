import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { NativePreparationReviewQueue } from "./native-adapter.js";
import type { PreparationJob } from "./index.js";

test("private exact native package is durable, bounded, world isolated, reviewed but never dispatched", () => {
  const db = new DatabaseSync(":memory:");
  let revision = "r1",
    reviews = 0;
  const queue = new NativePreparationReviewQueue(db, {
    authorize: () => {},
    assertPrivateStorage: () => {},
    currentSourceRevisions: () => ({ area: revision }),
    authorizeHumanReview: (approval, digest) => {
      assert.equal(approval, "human");
      assert.equal(digest.length, 64);
      reviews++;
    },
  });
  const job: PreparationJob = {
    version: 1,
    id: "job",
    input: {
      worldId: "one",
      requestId: "r",
      areaIds: ["area"],
      sourceRevisions: { area: "r1" },
      depth: "encounter",
      maxAreas: 1,
      desiredReadiness: "population",
    },
    revision: 3,
    state: "needs-review",
    stages: {
      area: { digest: "a", proposals: [{ id: "area", title: "Cave" }] },
      map: {
        digest: "m",
        proposals: [
          {
            areaId: "area",
            width: 1000,
            height: 1000,
            assetRef: "approved/map.webp",
            grid: { size: 100, distance: 5, units: "ft", originX: 0, originY: 0 },
          },
        ],
      },
      population: {
        digest: "p",
        proposals: [
          {
            areaId: "area",
            tokens: [
              { actorId: "actor", preparationId: "token", x: 0, y: 0, size: 1, hidden: true },
            ],
            gmNoteRecordIds: ["secret-note"],
            traps: [{ recordId: "secret-trap" }],
          },
        ],
      },
    },
    readiness: {
      records: true,
      map: true,
      population: true,
      visibility: false,
      trapMechanics: false,
      liveAccepted: false,
    },
    warnings: [],
    spending: { requests: 0, generationExecuted: false },
  };
  const caller = { worldId: "one", isGm: true };
  const value = queue.stage(caller, job, "area");
  assert.equal(queue.stage(caller, job, "area").id, value.id);
  assert.equal(value.sceneRequest.args.data["active"], false);
  assert.equal(JSON.stringify(value.sceneRequest).includes("secret-note"), false);
  assert.equal(JSON.stringify(value.sceneRequest).includes("secret-trap"), false);
  assert.throws(() => queue.get({ ...caller, worldId: "two" }, value.id), /unavailable/);
  assert.throws(() => queue.get({ ...caller, isGm: false }, value.id), /unavailable/);
  queue.review(caller, value.id, "human");
  assert.equal(reviews, 1);
  assert.throws(() => queue.dispatch(caller, value.id), /dispatch blocked/);
  revision = "r2";
  assert.throws(() => queue.review(caller, value.id, "human"), /Stale/);
  db.close();
});
