import assert from "node:assert/strict";
import { it } from "node:test";
import { AutomaticTriggers, isBridgeMutation, type AutomaticSignal } from "./automatic-triggers.js";
import type { ChatKitTrigger } from "./chatkit-context.js";
const base: AutomaticSignal = {
  kind: "area",
  worldId: "w",
  sceneId: "s",
  documentId: "token",
  tokenId: "token",
  regionId: "region",
  key: "room",
  revision: 1,
  transition: "movement-1",
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
void it("identical multi-client events hash equally; distinct keyed areas and reentries remain distinct regardless of digest completion order", async () => {
  const events: ChatKitTrigger[] = [];
  const other: ChatKitTrigger[] = [];
  const adapter = new AutomaticTriggers((value) => events.push(value), 2);
  const second = new AutomaticTriggers((value) => other.push(value), 2);
  adapter.accept(base);
  adapter.accept({ ...base });
  second.accept(base);
  adapter.accept({ ...base, regionId: "region-2", key: "room2" });
  adapter.accept({ ...base, revision: 2, transition: "movement-2" });
  adapter.accept({
    ...base,
    bridgeOrigin: {
      source: "foundry-local-api.transaction",
      phase: "apply",
      correlationId: "aidm-echo",
    },
  });
  adapter.accept({ ...base, key: undefined } as unknown as AutomaticSignal);
  const deadline = Date.now() + 2000;
  while ((events.length < 3 || other.length < 1) && Date.now() < deadline) await tick();
  assert.equal(events.length, 3);
  assert.equal(other.length, 1);
  const original = events.find((event) => event.automatic?.key === "room" && event.automatic.revision === 1);
  const distinctArea = events.find((event) => event.automatic?.key === "room2");
  assert.ok(original);
  assert.ok(distinctArea);
  assert.equal(original.requestId, other[0]!.requestId);
  assert.equal(new Set(events.map((event) => event.requestId)).size, 3);
  assert.ok(events.every((event) => event.requestId!.length <= 128));
  assert.match(distinctArea.prompt, /room2/);
  adapter.cancel();
  second.cancel();
});
void it("disable/world changes and lifecycle cancellation abort queued timers and dispatched turns", async () => {
  let enabled = true;
  let world = "w";
  const events: AbortSignal[] = [];
  const adapter = new AutomaticTriggers(
    (_request, signal) => events.push(signal),
    2,
    (signal) => enabled && signal.worldId === world,
  );
  adapter.accept(base);
  enabled = false;
  await tick();
  assert.equal(events.length, 0);
  enabled = true;
  adapter.accept({ ...base, revision: 2 });
  world = "other";
  await tick();
  assert.equal(events.length, 0);
  world = "w";
  adapter.accept({ ...base, revision: 3 });
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.aborted, false);
  adapter.cancel();
  assert.equal(events[0]!.aborted, true);
  adapter.accept({ ...base, revision: 4 });
  adapter.cancel();
  await tick();
  assert.equal(events.length, 1);
});
void it("only reviewed structured bridge provenance suppresses events; arbitrary identity strings are not grants", () => {
  assert.equal(
    isBridgeMutation({
      source: "foundry-local-api.world-document",
      phase: "apply",
      correlationId: "aidm-world",
    }),
    true,
  );
  assert.equal(
    isBridgeMutation({
      source: "foundry-local-api.session-action",
      phase: "apply",
      correlationId: "aidm-session",
    }),
    true,
  );
  assert.equal(isBridgeMutation("ai-dungeon-master"), false);
  assert.equal(
    isBridgeMutation({ source: "model", phase: "apply", correlationId: "aidm-forged" }),
    false,
  );
  assert.equal(
    isBridgeMutation({
      source: "foundry-local-api.transaction",
      phase: "compensate",
      correlationId: "aidm-known",
    }),
    true,
  );
});
