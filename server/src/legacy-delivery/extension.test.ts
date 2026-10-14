import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildMovementEvent } from "../../../../foundry-local-api/shared/dist/index.js";
import { MovementEventStore } from "./test-api-fixtures.js";
import { AiGmDeliveryService } from "./ai-gm-delivery.js";
import { registerLegacyDelivery } from "./extension.js";
import type { AnyEndpointDescriptor, LegacyDeliveryContext } from "./api-contract.js";

void test("AI extension adopts the legacy queue, registers original tools, reconciles generic movement, and cleans up", async t => {
  const directory = mkdtempSync(join(tmpdir(), "legacy-dm-adoption-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queuePath = join(directory, "ai-gm-deliveries.json");
  const movementPath = join(directory, "movement-events.json");
  let store = new MovementEventStore(movementPath);
  const queue = new AiGmDeliveryService(queuePath, "codex-active-ai-gm");
  queue.initializeReconciliationWatermark(store, 0);
  const before = readFileSync(queuePath, "utf8");
  let listener: (() => void) | undefined;
  let shutdown: (() => void | Promise<void>) | undefined;
  let descriptors: AnyEndpointDescriptor[] = [];
  let disposed = 0;
  const context = {
    runtimeRoot: pathToFileURL(`${directory}/`),
    movement: {
      path: movementPath,
      getStore: () => store,
      reloadStore: () => { store = new MovementEventStore(movementPath); },
      diagnose: () => MovementEventStore.diagnose(movementPath),
      onRecord: (handler: () => void) => { listener = handler; return () => { listener = undefined; disposed++; }; },
    },
    registerEndpoints: (registered: AnyEndpointDescriptor[]) => { descriptors = registered; return () => { descriptors = []; disposed++; }; },
    onShutdown: (handler: () => void | Promise<void>) => { shutdown = handler; return () => undefined; },
  } as unknown as LegacyDeliveryContext;
  registerLegacyDelivery(context);
  assert.equal(readFileSync(queuePath, "utf8"), before, "existing empty watermark is adopted without rewrite");
  assert.deepEqual(descriptors.map(({ name }) => name), [
    "foundry_list_ai_gm_deliveries", "foundry_get_ai_gm_delivery", "foundry_rollover_movement_store_generation",
  ]);
  store.append(buildMovementEvent({ eventId: "adopt-movement-001", sceneId: "scene", tokenId: "token", userId: "user", timestamp: 1, waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }], regions: [] }));
  listener!();
  const adopted = new AiGmDeliveryService(queuePath, "codex-active-ai-gm");
  assert.equal(adopted.list().length, 1);
  assert.equal(adopted.list()[0]?.state, "queued", "unavailable host adapter never invents retries");
  assert.equal(adopted.getReconciliationWatermark()?.sequence, 1);
  assert.equal(adopted.list()[0]?.consumerId, "codex-active-ai-gm");
  const saved = readFileSync(queuePath, "utf8");
  await shutdown!();
  assert.equal(listener, undefined);
  assert.equal(descriptors.length, 0);
  assert.equal(disposed, 2);
  assert.equal(readFileSync(queuePath, "utf8"), saved, "shutdown preserves adopted queue");
});
