import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildMovementEvent, type SequencedMovementEvent } from "../../../../foundry-local-api/shared/dist/index.js";
import { MovementEventStore } from "./test-api-fixtures.js";
import {
  AiGmDeliveryService,
  type HostWakeAdapter,
  UnavailableHostWakeAdapter,
} from "./ai-gm-delivery.js";

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "ai-gm-delivery-")), "delivery.json");
}

function movement(eventId = "move-1", sequence = 1): SequencedMovementEvent {
  return {
    ...buildMovementEvent({
      eventId,
      sceneId: "scene-1",
      tokenId: "token-1",
      userId: "izzy-user",
      timestamp: 100,
      waypoints: [
        { x: 0, y: 0, elevation: 0 },
        { x: 10, y: 0, elevation: 5 },
      ],
      regions: [],
    }),
    sequence,
  };
}

function preparationMovement(eventId = "preparation-rollback"): SequencedMovementEvent {
  return {
    ...buildMovementEvent({
      eventId,
      sceneId: "Nbj38PEdvw1zX1J9",
      tokenId: "mRgn9lP9y9fY3jcw",
      userId: "X7X4KK7zca5U2Ics",
      timestamp: 100,
      waypoints: [
        { x: 450, y: 650, elevation: 0 },
        { x: 500, y: 500, elevation: 0 },
      ],
      regions: [],
    }),
    sequence: 1,
  };
}

void describe("durable AI-GM delivery", () => {
  void it("persists stable consumer, event/cursor linkage, and pending adjudication", () => {
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 1_000 });
    const firstStop = {
      reason: "hazard",
      acceptedPoint: { x: 4, y: 0, elevation: 2 },
      remainingPath: [
        { x: 4, y: 0, elevation: 2 },
        { x: 10, y: 0, elevation: 5 },
      ],
    };
    const queued = service.enqueue(movement(), "session:1", firstStop);

    assert.equal(queued.created, true);
    assert.equal(queued.item.consumerId, "ai-gm-primary");
    assert.equal(queued.item.eventSequence, 1);
    assert.equal(queued.item.eventCursor, "session:1");
    assert.deepEqual(queued.item.adjudication.firstStop, firstStop);
    assert.equal(queued.item.adjudication.status, "pending_adjudication");
    assert.equal(queued.item.adjudication.automaticConsequencesApplied, false);
    assert.deepEqual(service.getQueueSummary(), {
      total: 1,
      pendingAdjudication: 1,
      states: {
        queued: 1,
        in_flight: 0,
        retry_wait: 0,
        acknowledged: 0,
        dead_letter: 0,
      },
      reconciliationWatermark: null,
    });

    const restarted = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 2_000 });
    assert.deepEqual(restarted.get(queued.item.id), queued.item);
    assert.throws(
      () => new AiGmDeliveryService(path, "different-consumer"),
      /belongs to consumer ai-gm-primary/,
    );
  });

  void it("syncs from the canonical movement store and handles duplicate replay idempotently", () => {
    const movementPath = fixturePath();
    const deliveryPath = fixturePath();
    const movementStore = new MovementEventStore(movementPath);
    movementStore.append(movement("event-a"));
    movementStore.append(movement("event-b"));
    const service = new AiGmDeliveryService(deliveryPath, "ai-gm-primary");

    const first = service.syncFromMovementStore(movementStore);
    const replay = service.syncFromMovementStore(movementStore);

    assert.deepEqual(
      first.created.map((item) => item.eventId),
      ["event-a", "event-b"],
    );
    assert.equal(replay.created.length, 0);
    assert.deepEqual(
      replay.existing.map((item) => item.id),
      first.created.map((item) => item.id),
    );
    assert.equal(service.list().length, 2);
  });

  void it("initializes after preparation sequence 1 and never enqueues the excluded event", () => {
    const movementStore = new MovementEventStore(fixturePath());
    movementStore.append(preparationMovement());
    movementStore.append(movement("live-movement"));
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 1_000 });

    const initialized = service.initializeReconciliationWatermark(movementStore, 1);
    const reconciled = service.reconcileMovementStore(movementStore);

    assert.equal(initialized.initialized, true);
    assert.equal(initialized.watermark.sequence, 1);
    assert.deepEqual(
      reconciled.created.map((item) => item.eventId),
      ["live-movement"],
    );
    assert.equal(reconciled.watermark.sequence, 2);
    assert.equal(
      service.list().some((item) => item.eventId === "preparation-rollback"),
      false,
    );

    const secondInitialization = service.initializeReconciliationWatermark(movementStore, 99);
    assert.equal(secondInitialization.initialized, false);
    assert.equal(secondInitialization.watermark.sequence, 2);
  });

  void it("starts before sequence 1 unless the exact guarded preparation evidence matches", () => {
    const emptyStore = new MovementEventStore(fixturePath());
    const emptyService = new AiGmDeliveryService(fixturePath(), "ai-gm-primary");
    assert.equal(
      emptyService.initializeReconciliationWatermark(emptyStore, 1).watermark.sequence,
      0,
    );

    const movementStore = new MovementEventStore(fixturePath());
    movementStore.append(movement("first-real-movement"));
    const service = new AiGmDeliveryService(fixturePath(), "ai-gm-primary");
    const initialized = service.initializeReconciliationWatermark(movementStore, 1);
    const reconciled = service.reconcileMovementStore(movementStore);

    assert.equal(initialized.watermark.sequence, 0);
    assert.deepEqual(
      reconciled.created.map((item) => item.eventId),
      ["first-real-movement"],
    );
    assert.throws(
      () =>
        new AiGmDeliveryService(fixturePath(), "ai-gm-primary").initializeReconciliationWatermark(
          movementStore,
          2,
        ),
      /only the guarded preparation event/,
    );

    for (const nearMatch of [
      { ...preparationMovement(), userId: "different-user" },
      {
        ...preparationMovement(),
        waypoints: [
          { x: 450, y: 650, elevation: 0 },
          { x: 501, y: 500, elevation: 0 },
        ],
      },
    ]) {
      const nearMatchStore = new MovementEventStore(fixturePath());
      nearMatchStore.append(nearMatch);
      const nearMatchService = new AiGmDeliveryService(fixturePath(), "ai-gm-primary");
      assert.equal(
        nearMatchService.initializeReconciliationWatermark(nearMatchStore, 1).watermark.sequence,
        0,
      );
      assert.equal(nearMatchService.reconcileMovementStore(nearMatchStore).created.length, 1);
    }
  });

  void it("reconciles an append-enqueue crash gap after delivery-service restart", () => {
    const movementStore = new MovementEventStore(fixturePath());
    movementStore.append(preparationMovement());
    const path = fixturePath();
    const first = new AiGmDeliveryService(path, "ai-gm-primary");
    first.initializeReconciliationWatermark(movementStore, 1);

    movementStore.append(movement("appended-before-crash"));
    const restarted = new AiGmDeliveryService(path, "ai-gm-primary");
    const recovered = restarted.reconcileMovementStore(movementStore);

    assert.deepEqual(
      recovered.created.map((item) => item.eventId),
      ["appended-before-crash"],
    );
    assert.equal(recovered.watermark.sequence, 2);
    assert.equal(restarted.getReconciliationWatermark()?.sequence, 2);
  });

  void it("advances a stale watermark through duplicate replay without duplicating work", () => {
    const movementStore = new MovementEventStore(fixturePath());
    movementStore.append(preparationMovement());
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary");
    service.initializeReconciliationWatermark(movementStore, 1);
    const event = movementStore.append(movement("already-enqueued"));
    service.enqueue(event, movementStore.cursor(event.sequence));

    const restarted = new AiGmDeliveryService(path, "ai-gm-primary");
    const replay = restarted.reconcileMovementStore(movementStore);

    assert.equal(replay.created.length, 0);
    assert.deepEqual(
      replay.existing.map((item) => item.eventId),
      ["already-enqueued"],
    );
    assert.equal(replay.watermark.sequence, 2);
    assert.equal(restarted.list().length, 1);
    assert.equal(restarted.reconcileMovementStore(movementStore).created.length, 0);
    assert.equal(restarted.list().length, 1);
  });

  void it("persists reconciliation watermark across restart and fails closed on generation change", () => {
    const movementStore = new MovementEventStore(fixturePath());
    movementStore.append(preparationMovement());
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 1_000 });
    const initialized = service.initializeReconciliationWatermark(movementStore, 1).watermark;

    const restarted = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 2_000 });
    assert.deepEqual(restarted.getReconciliationWatermark(), initialized);
    assert.throws(
      () =>
        restarted.reconcileMovementStore({
          generation: "different-generation",
          cursor: (sequence) => `different-generation:${sequence}`,
          query: (input) => movementStore.query(input),
        }),
      /generation changed.*missing range is unknown/,
    );
  });

  void it("reports an exact same-generation retention gap", () => {
    const movementStore = new MovementEventStore(fixturePath(), 1);
    movementStore.append(preparationMovement());
    const service = new AiGmDeliveryService(fixturePath(), "ai-gm-primary");
    service.initializeReconciliationWatermark(movementStore, 1);
    movementStore.append(movement("expired-movement"));
    movementStore.append(movement("retained-movement"));

    assert.throws(() => service.reconcileMovementStore(movementStore), /exact expired gap 2-2/);
  });

  void it("rolls back an enqueue when its durable save fails", () => {
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary");
    mkdirSync(path);

    assert.throws(() => service.enqueue(movement(), "session:1"));
    assert.deepEqual(service.list(), []);
  });

  void it("does not acknowledge an event when the acknowledgement save fails", async () => {
    const path = fixturePath();
    const backup = `${path}.backup`;
    const service = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 1_000 });
    const queued = service.enqueue(movement(), "session:1").item;
    const adapter: HostWakeAdapter = {
      capability: "invoke",
      deliver: () => {
        renameSync(path, backup);
        mkdirSync(path);
        return Promise.resolve({ status: "acknowledged", acknowledgementId: "unpersisted-ack" });
      },
    };

    await assert.rejects(() => service.dispatchDue(adapter));
    assert.equal(service.get(queued.id)?.state, "in_flight");
    assert.equal(service.get(queued.id)?.acknowledgementId, undefined);

    rmSync(path, { recursive: true });
    renameSync(backup, path);
    const restarted = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 2_000 });
    assert.equal(restarted.get(queued.id)?.state, "retry_wait");
    assert.equal(restarted.get(queued.id)?.acknowledgementId, undefined);
    assert.equal(restarted.get(queued.id)?.attemptHistory[0]?.outcome, "interrupted");
  });

  void it("persists acknowledgement and treats the same acknowledgement as idempotent", async () => {
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 1_000 });
    const queued = service.enqueue(movement(), "session:1").item;
    const adapter: HostWakeAdapter = {
      capability: "invoke",
      deliver: (request) => Promise.resolve({
        status: "acknowledged",
        acknowledgementId: `ack-${request.deliveryId}`,
      }),
    };

    assert.deepEqual(await service.dispatchDue(adapter), {
      attempted: 1,
      acknowledged: 1,
      retryScheduled: 0,
      deadLettered: 0,
    });
    const acknowledged = service.get(queued.id)!;
    assert.equal(acknowledged.state, "acknowledged");
    assert.equal(acknowledged.attemptHistory.length, 1);
    assert.equal(acknowledged.attemptHistory[0]?.outcome, "acknowledged");
    assert.deepEqual(service.acknowledge(queued.id, acknowledged.acknowledgementId!), acknowledged);
    assert.throws(() => service.acknowledge(queued.id, "different-ack"), /different/);
    assert.deepEqual(await service.dispatchDue(adapter), {
      attempted: 0,
      acknowledged: 0,
      retryScheduled: 0,
      deadLettered: 0,
    });
    assert.equal(
      new AiGmDeliveryService(path, "ai-gm-primary").get(queued.id)?.state,
      "acknowledged",
    );
  });

  void it("schedules bounded retries, exposes host outage, and dead-letters durably", async () => {
    let now = 1_000;
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary", {
      now: () => now,
      maxAttempts: 2,
      retryBaseMs: 100,
      retryMaxMs: 100,
    });
    const queued = service.enqueue(movement(), "session:1").item;
    const unavailable = new UnavailableHostWakeAdapter(
      "This runtime has no configured AI-GM invocation or wake channel.",
    );

    assert.equal(unavailable.capability, "unavailable");
    assert.match(unavailable.limitation, /no configured AI-GM/);
    const first = await service.dispatchDue(unavailable);
    assert.equal(first.retryScheduled, 1);
    const waiting = service.get(queued.id)!;
    assert.equal(waiting.state, "retry_wait");
    assert.equal(waiting.nextAttemptAt, 1_100);
    assert.equal(waiting.lastFailure?.code, "HOST_INVOCATION_UNAVAILABLE");
    assert.equal(waiting.attemptHistory[0]?.outcome, "retry_scheduled");

    assert.equal((await service.dispatchDue(unavailable)).attempted, 0);
    now = 1_100;
    const second = await service.dispatchDue(unavailable);
    assert.equal(second.deadLettered, 1);
    const dead = service.get(queued.id)!;
    assert.equal(dead.state, "dead_letter");
    assert.equal(dead.attemptHistory.length, 2);
    assert.equal(dead.attemptHistory[1]?.outcome, "dead_letter");
    assert.equal(dead.adjudication.status, "pending_adjudication");
    assert.equal(dead.adjudication.automaticConsequencesApplied, false);
    assert.equal(
      new AiGmDeliveryService(path, "ai-gm-primary").get(queued.id)?.state,
      "dead_letter",
    );
  });

  void it("recovers a persisted in-flight attempt after process interruption", () => {
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 1_000 });
    const queued = service.enqueue(movement(), "session:1").item;
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      items: Array<Record<string, unknown>>;
    };
    Object.assign(state.items[0]!, {
      state: "in_flight",
      nextAttemptAt: undefined,
      attemptHistory: [{ attempt: 1, startedAt: 1_000 }],
    });
    writeFileSync(path, JSON.stringify(state));

    const restarted = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 2_000 });
    const recovered = restarted.get(queued.id)!;
    assert.equal(recovered.state, "retry_wait");
    assert.equal(recovered.nextAttemptAt, 2_000);
    assert.equal(recovered.attemptHistory[0]?.outcome, "interrupted");
    assert.equal(recovered.lastFailure?.code, "HOST_PROCESS_INTERRUPTED");
  });

  void it("bounds host invocation time and records the timeout for retry", async () => {
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary", {
      attemptTimeoutMs: 5,
      retryBaseMs: 10,
    });
    const queued = service.enqueue(movement(), "session:1").item;
    let aborted = false;
    const adapter: HostWakeAdapter = {
      capability: "wake",
      deliver: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({
              status: "rejected",
              code: "ABORTED",
              message: "aborted",
              retryable: true,
            });
          });
        }),
    };

    const result = await service.dispatchDue(adapter);
    assert.equal(result.retryScheduled, 1);
    assert.equal(aborted, true);
    assert.equal(service.get(queued.id)?.lastFailure?.code, "HOST_INVOCATION_TIMEOUT");
  });

  void it("dead-letters non-retryable rejection immediately and rejects corrupt state", async () => {
    const path = fixturePath();
    const service = new AiGmDeliveryService(path, "ai-gm-primary");
    const queued = service.enqueue(movement(), "session:1").item;
    const adapter: HostWakeAdapter = {
      capability: "invoke",
      deliver: () => Promise.resolve({
        status: "rejected",
        code: "CONSUMER_REJECTED",
        message: "Consumer refused the work item.",
        retryable: false,
      }),
    };

    assert.equal((await service.dispatchDue(adapter)).deadLettered, 1);
    assert.equal(service.get(queued.id)?.state, "dead_letter");

    const corruptPath = fixturePath();
    writeFileSync(corruptPath, "{not-json");
    assert.throws(() => new AiGmDeliveryService(corruptPath, "ai-gm-primary"), /store is corrupt/);
  });
});
