import assert from "node:assert/strict";
import { test } from "node:test";
import { RegionMutationOrigins } from "./mutation-origin.js";
const token = () => ({
  id: "t",
  uuid: "Scene.s.Token.t",
  parent: { id: "s" },
  x: 10,
  y: 20,
  _stats: { modifiedTime: 1 },
});
const options = (movement: object) => ({
  correlationId: "aidm-one",
  foundryLocalApi: { authorizedGmMovement: true },
  foundryLocalApiOrigin: {
    source: "foundry-local-api.session-action",
    phase: "apply",
    correlationId: "aidm-one",
  },
  _movement: { t: movement },
});
void test("world document origin retains its exact source; arbitrary lookalike sources do not suppress Regions", () => {
  const cache = new RegionMutationOrigins();
  const movement = { id: "world-move", passed: { waypoints: [{ x: 10, y: 20 }] } };
  const opts = options(movement);
  opts.foundryLocalApiOrigin.source = "foundry-local-api.world-document";
  cache.observe("w", token(), { x: 10 }, opts);
  assert.equal(cache.match("w", token(), movement)?.source, "foundry-local-api.world-document");
  opts.foundryLocalApiOrigin.source = "foundry-local-api.world-document.forged";
  cache.observe("w", token(), { x: 10 }, opts);
  assert.equal(cache.match("w", token(), movement), undefined);
});
void test("matches only exact core operation trajectory and revision; all keyed entries share provenance", () => {
  const cache = new RegionMutationOrigins();
  const doc = token();
  const movement = { id: "move1", passed: { waypoints: [{ x: 10, y: 20 }] } };
  cache.observe("w", doc, { x: 10, y: 20 }, options(movement));
  assert.equal(cache.match("w", doc, movement)?.correlationId, "aidm-one");
  assert.equal(cache.match("w", doc, movement)?.correlationId, "aidm-one");
  assert.equal(cache.match("w", doc, structuredClone(movement)), undefined);
  assert.equal(cache.match("other", doc, movement), undefined);
  assert.equal(cache.match("w", { ...doc, parent: { id: "other" } }, movement), undefined);
});
void test("manual/newer/unknown/malformed movement invalidates; pre-update cannot guess future event", () => {
  const cache = new RegionMutationOrigins();
  const doc = token();
  const first = { id: "first", passed: { waypoints: [{ x: 30, y: 40 }] } };
  cache.observe("w", doc, { x: 30, y: 40 }, options(first));
  assert.equal(cache.match("w", doc, first), undefined);
  doc.x = 30;
  doc.y = 40;
  doc._stats.modifiedTime = 2;
  cache.observe("w", doc, { x: 30, y: 40 }, options(first));
  assert.ok(cache.match("w", doc, first));
  cache.observe("w", doc, { x: 30 }, {});
  assert.equal(cache.match("w", doc, first), undefined);
  cache.observe("w", doc, { x: 30 }, { ...options(first), correlationId: "other" });
  assert.equal(cache.match("w", doc, first), undefined);
  cache.observe("w", doc, { x: 30 }, options(first));
  doc._stats.modifiedTime = 3;
  assert.equal(cache.match("w", doc, first), undefined);
});
void test("rapid overlapping moves, expiry, clear/reopen and bounded retention do not suppress unrelated entries", () => {
  let now = 0;
  const cache = new RegionMutationOrigins(() => now, 10, 1);
  const doc = token();
  const first = { id: "first", passed: { waypoints: [{ x: 10, y: 20 }] } },
    second = { id: "second", passed: { waypoints: [{ x: 10, y: 20 }] } };
  cache.observe("w", doc, { x: 10 }, options(first));
  cache.observe("w", doc, { x: 10 }, options(second));
  assert.equal(cache.match("w", doc, first), undefined);
  assert.ok(cache.match("w", doc, second));
  now = 11;
  assert.equal(cache.match("w", doc, second), undefined);
  cache.observe("w", doc, { x: 10 }, options(second));
  cache.clear();
  assert.equal(cache.match("w", doc, second), undefined);
  cache.observe("w", doc, { x: 10 }, options(second));
  const other = { ...doc, uuid: "Scene.s.Token.other" };
  cache.observe("w", other, { x: 10 }, options(second));
  assert.equal(cache.match("w", doc, second), undefined);
});
