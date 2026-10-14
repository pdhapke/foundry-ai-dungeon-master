import assert from "node:assert/strict";
import test from "node:test";
import { playerReadiness } from "./player-readiness.js";

void test("server/GM health and incomplete native evidence never mean player ready", () => {
  for (const value of [{status: "ready"}, {status: "complete", observation: {isGM: true}}, null])
    assert.deepEqual(playerReadiness(value), {status: "incomplete", retryable: true, binding: null});
  assert.equal(playerReadiness({status: "unavailable", issues: [{code: "NOT_CONNECTED"}]}).status, "NOT_CONNECTED");
  assert.equal(playerReadiness({status: "unsupported"}).status, "unsupported");
  assert.equal(playerReadiness({status: "stale"}).status, "stale");
});
void test("readiness binding exposes provenance only, never auxiliary secrets", () => {
  const report = {status: "complete", issues: [], observation: {worldId: "w", sceneId: "s", userId: "u",
    clientId: "c", tokenId: "t", stateRevision: "r", id: "o", isGM: false, optedIn: true,
    readiness: "ready", pendingRenderFlags: 0, secret: "hidden-trap"}};
  const result = playerReadiness(report);
  assert.equal(result.status, "ready");
  assert.equal(JSON.stringify(result).includes("hidden-trap"), false);
  report.observation.pendingRenderFlags = 1;
  assert.equal(playerReadiness(report).status, "incomplete");
});
