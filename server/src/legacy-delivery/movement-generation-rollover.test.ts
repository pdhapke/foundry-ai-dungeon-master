import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MovementEventStore } from "./test-api-fixtures.js";
import {
  MovementGenerationRolloverError,
  MovementGenerationRolloverService,
} from "./movement-generation-rollover.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "movement-rollover-"));
  const movementPath = join(directory, "movement-events.json");
  const deliveryPath = join(directory, "ai-gm-deliveries.json");
  const eventId = "legacy-event";
  const compact = {
    eventId,
    eventType: "token_movement",
    movementFields: ["x"],
    sceneId: "scene",
    tokenId: "token",
    userId: "user",
    timestamp: 1,
    from: { x: 0, y: 0 },
    to: { x: 1, y: 0 },
    footprint: { width: 0, height: 0 },
    deltas: [{ dx: 1, dy: 0, delevation: 0 }],
    waypoints: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
    segments: [
      {
        index: 0,
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0 },
        dx: 1,
        dy: 0,
        delevation: 0,
      },
    ],
    transitions: [],
    acceptedPoint: { x: 1, y: 0 },
    remainingPath: [],
  };
  const movement = JSON.stringify({
    version: 2,
    generation: "legacy-generation",
    nextSequence: 2,
    events: [{ ...compact, sequence: 1 }],
    eventSequences: { [eventId]: 1 },
    eventHashes: { [eventId]: hash(JSON.stringify(compact)) },
  });
  const delivery = JSON.stringify({
    version: 2,
    consumerId: "consumer",
    items: [{ id: "historical-delivery" }],
    reconciliationWatermark: {
      generation: "legacy-generation",
      sequence: 1,
      cursor: "legacy-generation:1",
      initializedAt: 1,
      updatedAt: 1,
    },
  });
  writeFileSync(movementPath, movement);
  writeFileSync(deliveryPath, delivery);
  return { directory, movementPath, deliveryPath, movement, delivery };
}

void describe("movement generation rollover", () => {
  void it("archives exact bytes, starts empty valid stores, and replays idempotently", () => {
    const f = fixture();
    const service = new MovementGenerationRolloverService(
      f.movementPath,
      f.deliveryPath,
      "consumer",
      () => 1234,
      () => MovementEventStore.diagnose(f.movementPath),
    );
    const input = {
      expectedGeneration: "legacy-generation",
      expectedMovementSha256: hash(f.movement),
      idempotencyKey: "rollover-test-0001",
      confirmation: "quarantine-and-rollover" as const,
    };
    const first = service.rollover(input);
    // Simulate a crash immediately after the receipt was committed but before
    // either quarantine artifact or replacement became durable.
    unlinkSync(join(f.directory, "movement-history", first.quarantine.movementFile));
    unlinkSync(join(f.directory, "movement-history", first.quarantine.deliveryFile));
    writeFileSync(f.movementPath, f.movement);
    writeFileSync(f.deliveryPath, f.delivery);
    const replay = service.rollover(input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual({ ...replay, replayed: false }, first);
    assert.notEqual(first.newGeneration, first.oldGeneration);
    assert.equal(first.quarantine.deliveryItemCount, 1);
    assert.equal(
      readFileSync(join(f.directory, "movement-history", first.quarantine.movementFile), "utf8"),
      f.movement,
    );
    assert.equal(
      readFileSync(join(f.directory, "movement-history", first.quarantine.deliveryFile), "utf8"),
      f.delivery,
    );
    assert.equal(MovementEventStore.diagnose(f.movementPath).valid, true);
    const currentDelivery = JSON.parse(readFileSync(f.deliveryPath, "utf8")) as {
      items: unknown[];
      reconciliationWatermark: { generation: string; sequence: number; cursor: string };
    };
    assert.deepEqual(currentDelivery.items, []);
    assert.deepEqual(currentDelivery.reconciliationWatermark, {
      generation: first.newGeneration,
      sequence: 0,
      cursor: `${first.newGeneration}:0`,
      initializedAt: 1234,
      updatedAt: 1234,
    });
    assert.equal(existsSync(join(f.directory, "movement-history")), true);
  });

  void it("fails closed on hash drift, idempotency reuse, and healthy stores", () => {
    const drift = fixture();
    const service = new MovementGenerationRolloverService(
      drift.movementPath,
      drift.deliveryPath,
      "consumer",
      Date.now,
      () => MovementEventStore.diagnose(drift.movementPath),
    );
    assert.throws(
      () =>
        service.rollover({
          expectedGeneration: "legacy-generation",
          expectedMovementSha256: "0".repeat(64),
          idempotencyKey: "rollover-test-0002",
          confirmation: "quarantine-and-rollover",
        }),
      (error: unknown) =>
        error instanceof MovementGenerationRolloverError && error.code === "HASH_MISMATCH",
    );

    const completed = service.rollover({
      expectedGeneration: "legacy-generation",
      expectedMovementSha256: hash(drift.movement),
      idempotencyKey: "rollover-test-0003",
      confirmation: "quarantine-and-rollover",
    });
    assert.throws(
      () =>
        service.rollover({
          expectedGeneration: "different-generation",
          expectedMovementSha256: hash(drift.movement),
          idempotencyKey: "rollover-test-0003",
          confirmation: "quarantine-and-rollover",
        }),
      (error: unknown) =>
        error instanceof MovementGenerationRolloverError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const healthyDirectory = mkdtempSync(join(tmpdir(), "movement-rollover-healthy-"));
    const healthyMovement = join(healthyDirectory, "movement-events.json");
    const healthyDelivery = join(healthyDirectory, "ai-gm-deliveries.json");
    const healthyStore = new MovementEventStore(healthyMovement);
    writeFileSync(
      healthyDelivery,
      JSON.stringify({ version: 2, consumerId: "consumer", items: [] }),
    );
    const healthyBytes = readFileSync(healthyMovement);
    assert.throws(
      () =>
        new MovementGenerationRolloverService(
          healthyMovement,
          healthyDelivery,
          "consumer",
        ).rollover({
          expectedGeneration: healthyStore.generation,
          expectedMovementSha256: hash(healthyBytes),
          idempotencyKey: "rollover-test-0004",
          confirmation: "quarantine-and-rollover",
        }),
      (error: unknown) =>
        error instanceof MovementGenerationRolloverError && error.code === "STORE_NOT_RECOVERABLE",
    );
    assert.equal(completed.status, "completed");
  });
});
