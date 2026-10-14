import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PreparationJobService,
  auditUniformGrid,
  geometryMigrationImpact,
  type PreparationJobStore,
  type PreparationJob,
  type PreparationMapCandidate,
  type ReviewedNativePreparationAdapter,
} from "./index.js";

function fixture() {
  const jobs = new Map<string, PreparationJob>();
  const store: PreparationJobStore = {
    read: (key) => structuredClone(jobs.get(key)),
    write: (job, expected) => {
      assert.equal(jobs.get(job.id)?.revision ?? null, expected);
      jobs.set(job.id, structuredClone(job));
    },
  };
  const revisions = { cave: "r1" };
  const service = new PreparationJobService(store, {
    authorize: (c) => {
      if (!c.isGm) throw new Error("denied");
    },
    currentSourceRevisions: () => revisions,
  });
  const caller = { worldId: "one", isGm: true };
  const input = {
    worldId: "one",
    requestId: "request",
    areaIds: ["cave"],
    sourceRevisions: { cave: "r1" },
    depth: "encounter" as const,
    maxAreas: 1,
    desiredReadiness: "population" as const,
  };
  const job = service.create(caller, input);
  const area = {
    id: "cave",
    revision: "r1",
    title: "Authored cave",
    travelLinks: [],
    entryPoints: [],
    encounterRecordIds: [],
  };
  const map: PreparationMapCandidate = {
    areaId: "cave",
    assetRef: "authorized/map.webp",
    source: "fixture",
    license: "fixture-owned",
    width: 1000,
    height: 1000,
    grid: { size: 100, distance: 5, units: "ft", originX: 0, originY: 0 },
    profile: "preparation-only",
    landmarks: [
      { x: 0, y: 0, gridColumn: 0, gridRow: 0, residualPixels: 0 },
      { x: 500, y: 500, gridColumn: 5, gridRow: 5, residualPixels: 0 },
      { x: 1000, y: 1000, gridColumn: 10, gridRow: 10, residualPixels: 0 },
    ],
    alignmentTolerancePixels: 1,
  };
  const population = {
    areaId: "cave",
    tokens: [
      {
        preparationId: "t1",
        actorId: "actor",
        recordId: "npc",
        x: 100,
        y: 100,
        size: 1,
        hidden: true,
      },
    ],
    gmNoteRecordIds: ["secret"],
    traps: [
      {
        recordId: "trap",
        activation: "never-during-preparation" as const,
        mechanics: "manual" as const,
        region: { x: 200, y: 200, width: 100, height: 100 },
        triggerConditions: "manual pressure check",
        detectionConditions: "GM checks supported rules",
        consequences: "manual adjudication",
        activationState: "inactive" as const,
      },
    ],
  };
  return { service, caller, input, job, revisions, area, map, population };
}
test("deterministic scoped stages repeat without duplicate results/spend", () => {
  const f = fixture();
  assert.equal(f.service.create(f.caller, f.input).id, f.job.id);
  const a = f.service.prepareAreas(f.caller, f.job.id, [f.area]);
  assert.equal(f.service.prepareAreas(f.caller, f.job.id, [f.area]).revision, a.revision);
  f.service.prepareMaps(f.caller, f.job.id, [f.map]);
  const p = f.service.preparePopulation(f.caller, f.job.id, [f.population]);
  assert.deepEqual(p.spending, { requests: 0, generationExecuted: false });
  assert.equal(p.readiness.trapMechanics, false);
  assert.equal(p.readiness.liveAccepted, false);
  assert.throws(() => f.service.status({ ...f.caller, worldId: "other" }, f.job.id), /unavailable/);
  assert.throws(() => f.service.status({ ...f.caller, isGm: false }, f.job.id), /unavailable/);
});
test("cancel/resume and stale source deletion fail closed", () => {
  const f = fixture();
  f.service.cancel(f.caller, f.job.id);
  assert.throws(() => f.service.prepareAreas(f.caller, f.job.id, [f.area]), /resume/);
  f.service.resume(f.caller, f.job.id);
  f.revisions.cave = "changed";
  assert.throws(() => f.service.prepareAreas(f.caller, f.job.id, [f.area]), /Stale/);
});
test("map drift and out-of-bounds token footprint rejected", () => {
  const f = fixture();
  f.service.prepareAreas(f.caller, f.job.id, [f.area]);
  assert.throws(
    () =>
      f.service.prepareMaps(f.caller, f.job.id, [
        {
          ...f.map,
          landmarks: [
            { x: 0, y: 0, gridColumn: 0, gridRow: 0, residualPixels: 9 },
            ...f.map.landmarks.slice(1),
          ],
        },
      ]),
    /calibration/,
  );
  f.service.prepareMaps(f.caller, f.job.id, [f.map]);
  assert.throws(
    () =>
      f.service.preparePopulation(f.caller, f.job.id, [
        { ...f.population, tokens: [{ ...f.population.tokens[0]!, x: 999 }] },
      ]),
    /footprint/,
  );
});
test("reviewed inactive native fixture adapter is receipt-idempotent", () => {
  const f = fixture();
  f.service.prepareAreas(f.caller, f.job.id, [f.area]);
  f.service.prepareMaps(f.caller, f.job.id, [f.map]);
  f.service.preparePopulation(f.caller, f.job.id, [f.population]);
  let calls = 0,
    active = true;
  const adapter: ReviewedNativePreparationAdapter = {
    authorizeReview: (approval) => assert.equal(approval, "human-review"),
    inspect: () => ({ worldId: "one", revision: "s1", active, dedicatedPreparationFixture: true }),
    findReceipt: () => undefined,
    apply: () => {
      calls++;
      return { sceneId: "draft", sceneRevision: "s2", receiptId: "native-receipt" };
    },
  };
  const input = {
    areaId: "cave",
    sceneId: "draft",
    expectedSceneRevision: "s1",
    approvalId: "human-review",
  };
  assert.throws(() => f.service.applyReviewedDraft(f.caller, f.job.id, input, adapter), /inactive/);
  active = false;
  f.service.applyReviewedDraft(f.caller, f.job.id, input, adapter);
  f.service.applyReviewedDraft(f.caller, f.job.id, input, adapter);
  assert.equal(calls, 1);
});
test("grid audit spans map edges and rejects nonuniform distortion without applying geometry", () => {
  const points = [
    { artworkX: 10, artworkY: 20, gridColumn: 0, gridRow: 0 },
    { artworkX: 910, artworkY: 920, gridColumn: 9, gridRow: 9 },
    { artworkX: 510, artworkY: 20, gridColumn: 5, gridRow: 0 },
  ];
  const fit = auditUniformGrid(points, 1000, 1000, 1);
  assert.equal(fit.uniformAlignmentAccepted, true);
  assert.equal(fit.uniformSpacing, 100);
  assert.equal(fit.originX, 10);
  const distorted = auditUniformGrid(
    points.map((p) => ({ ...p, artworkY: p.artworkY * 1.2 })),
    1000,
    1200,
    1,
  );
  assert.equal(distorted.uniformAlignmentAccepted, false);
  const impact = geometryMigrationImpact([{ kind: "trap", x: 10, y: 20 }], {
    scale: 2,
    offsetX: 5,
    offsetY: 6,
  });
  assert.equal(impact.applied, false);
  assert.equal(impact.points[0]?.proposedX, 25);
});
