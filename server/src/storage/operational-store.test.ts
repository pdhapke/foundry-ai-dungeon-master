import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  AiDmActionProposal,
  AiDmApprovalDecision,
  AiDmMessageContent,
  AiDmRun,
  AiDmThread,
} from "@foundry-ai-dungeon-master/shared";

import { openStorageDatabase, type AiDmStorageDatabase } from "./database.js";
import { AiDmStorageConflictError, AiDmStorageError } from "./errors.js";
import {
  AiDmOperationalStore,
  makeDeliveryInput,
  type AppendNormalizedEventInput,
} from "./operational-store.js";

const at = (seconds: number) => new Date(seconds * 1_000).toISOString();

async function fixture(): Promise<{
  database: AiDmStorageDatabase;
  store: AiDmOperationalStore;
}> {
  const path = join(mkdtempSync(join(tmpdir(), "ai-dm-operations-")), "operations.sqlite");
  const database = await openStorageDatabase({ path });
  return { database, store: new AiDmOperationalStore(database.connection) };
}

function event(
  id: string,
  payload: Record<string, string> = { text: "hello" },
): AppendNormalizedEventInput {
  return {
    schemaVersion: 1,
    eventId: id,
    eventType: "player.prompt.submitted",
    source: "direct-prompt",
    occurredAt: at(1),
    authenticatedIdentity: {
      clientId: "client-1",
      userId: "user-1",
      lane: "player",
      worldId: "world-1",
      isGm: false,
    },
    presentation: "normal",
    requestedAudience: { kind: "private" },
    contextHints: {},
    payload,
    sourceCorrelationId: `correlation-${id}`,
    deduplicationKey: `dedup-${id}`,
    sourceStateRevision: "world-revision-1",
  };
}

function thread(): AiDmThread {
  return {
    threadId: "thread-1",
    worldId: "world-1",
    ownerUserId: "user-1",
    participantScope: { kind: "users", userIds: ["user-1"] },
    authorizedAudienceKinds: ["private", "gm", "table"],
    revision: "thread-revision-1",
    status: "active",
    createdAt: at(1),
    updatedAt: at(1),
  };
}

function run(runId: string, eventId: string, attempt = 1): AiDmRun {
  return {
    runId,
    eventId,
    threadId: "thread-1",
    principal: {
      clientId: "client-1",
      connectionId: "connection-1",
      userId: "user-1",
      lane: "player",
      worldId: "world-1",
      isGm: false,
      role: 1,
      authorizedAudienceKinds: ["private"],
      permissionSnapshotRevision: "permission-revision-1",
    },
    attempt,
    status: "queued",
    statusRevision: 0,
    createdAt: at(2),
    updatedAt: at(2),
    providerResponseId: null,
    providerResponseRunBinding: null,
    budgets: {
      context: {
        maxReads: 10,
        maxDepth: 4,
        maxNodes: 20,
        maxCharacters: 20_000,
        maxEstimatedTokens: 5_000,
      },
      maxToolSearches: 4,
      maxLoadedDefinitions: 12,
      maxToolCalls: 8,
      maxProposalOperations: 4,
      maxOutputCharacters: 10_000,
      maxProviderAttempts: 2,
      maxWallClockMs: 60_000,
    },
    cancelRequestedAt: null,
    failureCode: null,
  };
}

function proposal(): AiDmActionProposal {
  return {
    proposalId: "proposal-1",
    runId: "run-1",
    causeEventId: "event-1",
    createdAt: at(3),
    expiresAt: at(100),
    status: "waiting-for-gm",
    proposalRevision: "proposal-revision-0001",
    policyRevision: "policy-revision-0001",
    catalogRevision: "catalog-revision-0001",
    summary: "Create a synthetic test token.",
    effectiveAudience: {
      scope: { kind: "users", userIds: ["user-1"] },
      transcript: true,
      mirrorToFoundryChat: false,
    },
    approvalAuthority: { kind: "gm" },
    operations: [
      {
        operationId: "operation-1",
        toolId: "foundry.token.create",
        arguments: { syntheticFixture: true },
        expectedRevisions: [
          {
            provider: "foundry-local-api",
            resourceKind: "Scene",
            resourceId: "scene-test",
            revision: "scene-revision-1",
          },
        ],
      },
    ],
    stateDeltas: [],
  };
}

function seed(store: AiDmOperationalStore): void {
  store.appendEvent(event("event-1"));
  store.createThread(thread());
  store.createRun(run("run-1", "event-1"));
}

void describe("AI Dungeon Master operational store", () => {
  void it("assigns monotonic event sequences and detects conflicting replay", async () => {
    const { database, store } = await fixture();
    const first = store.appendEvent(event("event-1"));
    const replay = store.appendEvent(event("event-1"));
    const second = store.appendEvent(event("event-2"));
    assert.equal(first.event.sequence, 1);
    assert.equal(replay.event.sequence, 1);
    assert.equal(replay.replayed, true);
    assert.equal(second.event.sequence, 2);
    assert.equal(
      store.getEventByDeduplicationKey("world-1", "dedup-event-1", "user-1", false)?.eventId,
      "event-1",
    );
    assert.equal(
      store.getEventByDeduplicationKey("world-1", "dedup-event-1", "other-user", false),
      null,
    );
    assert.equal(
      store.getEventByDeduplicationKey("other-world", "dedup-event-1", "user-1", true),
      null,
    );
    assert.throws(
      () => store.appendEvent(event("event-1", { text: "changed" })),
      AiDmStorageConflictError,
    );
    database.close();
  });

  void it("orders messages and deliveries and restores paged transcript history", async () => {
    const { database, store } = await fixture();
    seed(store);
    assert.equal(
      store.getThread("thread-1", {
        worldId: "world-1",
        requesterUserId: "user-1",
        requesterIsGm: false,
      })?.threadId,
      "thread-1",
    );
    assert.equal(
      store.resolveActiveThread("user-1", {
        worldId: "world-1",
        requesterUserId: "user-1",
        requesterIsGm: false,
      })?.threadId,
      "thread-1",
    );
    assert.equal(
      store.getThread("thread-1", {
        worldId: "world-1",
        requesterUserId: "other-user",
        requesterIsGm: false,
      }),
      null,
    );
    assert.equal(
      store.resolveActiveThread("user-1", {
        worldId: "other-world",
        requesterUserId: "user-1",
        requesterIsGm: true,
      }),
      null,
    );
    const content = (text: string): AiDmMessageContent => ({ kind: "plain-text", text });
    const first = store.appendMessage(
      {
        messageId: "message-1",
        threadId: "thread-1",
        runId: "run-1",
        eventId: "event-1",
        kind: "progress",
        deliveryClass: "private",
        effectiveAudience: {
          scope: { kind: "users", userIds: ["user-1"] },
          transcript: true,
          mirrorToFoundryChat: false,
        },
        createdAt: at(4),
        content: content("Reading the current room."),
      },
      [{ deliveryId: "delivery-1", recipientUserId: "user-1" }],
    );
    const second = store.appendMessage(
      {
        messageId: "message-2",
        threadId: first.message.threadId,
        runId: first.message.runId,
        eventId: first.message.eventId,
        kind: first.message.kind,
        deliveryClass: first.message.deliveryClass,
        effectiveAudience: first.message.effectiveAudience,
        createdAt: at(5),
        content: content("Done."),
      },
      [{ deliveryId: "delivery-2", recipientUserId: "user-1" }],
    );
    assert.equal(first.message.threadSequence, 1);
    assert.equal(first.deliveries[0]?.recipientSequence, 1);
    assert.equal(second.message.threadSequence, 2);
    assert.equal(second.deliveries[0]?.recipientSequence, 2);
    const page = store.fetchHistory({
      threadId: "thread-1",
      worldId: "world-1",
      requesterUserId: "user-1",
      requesterIsGm: false,
      afterSequence: 1,
      limit: 10,
    });
    assert.deepEqual(
      page.messages.map(({ messageId }) => messageId),
      ["message-2"],
    );
    assert.equal(page.hasMore, false);
    assert.throws(
      () =>
        store.fetchHistory({
          threadId: "thread-1",
          worldId: "world-1",
          requesterUserId: "other-user",
          requesterIsGm: false,
          limit: 10,
        }),
      (error: unknown) => error instanceof AiDmStorageError && error.code === "NOT_FOUND",
    );
    database.close();
  });

  void it("keeps provider continuation chains isolated to one fresh run", async () => {
    const { database, store } = await fixture();
    store.appendEvent(event("event-1"));
    store.appendEvent(event("event-2"));
    store.createThread(thread());
    store.createRun(run("run-1", "event-1"));
    store.createRun(run("run-2", "event-2"));
    store.bindProviderResponse("run-1", "response-one", 0, at(3));
    store.bindProviderResponse("run-2", "response-two", 0, at(3));
    const replayedRun = store.createRun(run("run-1", "event-1"));
    assert.equal(replayedRun.replayed, true);
    assert.equal(replayedRun.run.providerResponseId, "response-one");
    assert.equal(store.getProviderContinuation("run-1"), "response-one");
    assert.equal(store.getProviderContinuation("run-2"), "response-two");
    assert.throws(
      () => store.bindProviderResponse("run-1", "response-two", 1, at(4)),
      AiDmStorageConflictError,
    );
    assert.throws(
      () =>
        store.createRun({
          ...run("run-3", "event-2", 2),
          providerResponseId: "response-one",
          providerResponseRunBinding: "run-1",
        }),
      (error: unknown) =>
        error instanceof AiDmStorageError && error.code === "PROVIDER_CHAIN_SCOPE_INVALID",
    );
    database.close();
  });

  void it("deduplicates approvals and commit receipts while rejecting conflicts", async () => {
    const { database, store } = await fixture();
    seed(store);
    store.createProposal(proposal());
    assert.throws(
      () =>
        store.recordApproval({
          decisionId: "decision-player",
          proposalId: "proposal-1",
          decision: "approve",
          decidedAt: at(4),
          authenticatedIdentity: {
            clientId: "client-1",
            userId: "user-1",
            lane: "player",
            worldId: "world-1",
            isGm: false,
          },
          proposalRevision: "proposal-revision-0001",
        }),
      (error: unknown) =>
        error instanceof AiDmStorageError && error.code === "APPROVAL_UNAUTHORIZED",
    );
    const decision: AiDmApprovalDecision = {
      decisionId: "decision-1",
      proposalId: "proposal-1",
      decision: "approve",
      decidedAt: at(4),
      authenticatedIdentity: {
        clientId: "gm-client",
        userId: "gm-user",
        lane: "gm",
        worldId: "world-1",
        isGm: true,
      },
      proposalRevision: "proposal-revision-0001",
    };
    assert.equal(store.recordApproval(decision).replayed, false);
    assert.equal(store.recordApproval(decision).replayed, true);
    assert.equal(
      store.recordApproval({ ...decision, decisionId: "decision-retry", decidedAt: at(5) })
        .replayed,
      true,
    );
    assert.equal(store.createProposal(proposal()).proposal.status, "approved");
    assert.throws(
      () => store.recordApproval({ ...decision, decisionId: "decision-2", decision: "refuse" }),
      AiDmStorageConflictError,
    );

    const receipt = {
      receiptId: "receipt-1",
      proposalId: "proposal-1",
      operationId: "operation-1",
      idempotencyKey: "commit-proposal-1-operation-1",
      status: "verified" as const,
      result: { foundryDocumentId: "synthetic-token" },
      createdAt: at(5),
    };
    assert.equal(store.recordCommitReceipt(receipt).replayed, false);
    assert.equal(store.recordCommitReceipt(receipt).replayed, true);
    assert.equal(
      store.recordCommitReceipt({ ...receipt, receiptId: "receipt-retry", createdAt: at(6) })
        .replayed,
      true,
    );
    assert.throws(
      () =>
        store.recordCommitReceipt({
          ...receipt,
          receiptId: "receipt-2",
          result: { foundryDocumentId: "different-token" },
        }),
      AiDmStorageConflictError,
    );
    database.close();
  });

  void it("recovers expired outbox leases and marks uncertain work for reconciliation", async () => {
    const { database, store } = await fixture();
    seed(store);
    store.enqueueDelivery(
      makeDeliveryInput({
        deliveryId: "delivery-1",
        recipientUserId: "user-1",
        worldId: "world-1",
        threadId: "thread-1",
        runId: "run-1",
        occurredAt: at(3),
        message: {
          type: "aiDm.run.status",
          payload: { runId: "run-1", status: "queued", occurredAt: at(3) },
        },
      }),
    );
    store.transitionRun("run-1", 0, "projecting", at(4));
    store.transitionRun("run-1", 1, "reading-context", at(5));
    store.transitionRun("run-1", 2, "resolving", at(6));
    store.transitionRun("run-1", 3, "committing", at(7));
    const execution = {
      executionId: "execution-1",
      runId: "run-1",
      toolId: "foundry.token.create",
      effect: "commit",
      idempotencyKey: "execution-key-1",
      arguments: { syntheticFixture: true },
      createdAt: at(7),
    } as const;
    store.beginToolExecution(execution);
    assert.equal(
      store.beginToolExecution({ ...execution, executionId: "execution-retry", createdAt: at(8) })
        .replayed,
      true,
    );
    const firstLease = store.leaseDeliveries({
      workerId: "worker-1",
      now: at(4),
      leaseUntil: at(8),
      limit: 10,
    });
    assert.equal(firstLease[0]?.attempts, 1);
    const recovered = store.recoverInterruptedWork(at(9));
    assert.deepEqual(recovered, {
      failedRuns: 1,
      uncertainCommits: 1,
      recoveredOutboxRows: 1,
      toolExecutionsNeedingReconciliation: 1,
    });
    assert.equal(store.getRun("run-1")?.failureCode, "COMMIT_RECONCILIATION_REQUIRED");
    const secondLease = store.leaseDeliveries({
      workerId: "worker-2",
      now: at(9),
      leaseUntil: at(12),
      limit: 10,
    });
    assert.equal(secondLease[0]?.attempts, 2);
    database.close();
  });

  void it("redacts credential-shaped JSON keys before persistence", async () => {
    const { database, store } = await fixture();
    const stored = store.appendEvent(
      event("event-redaction", { text: "safe", apiKey: "must-not-persist" }),
    );
    assert.deepEqual(stored.event.payload, {
      apiKey: "[REDACTED]",
      text: "safe",
    });
    const serialized = (
      database.connection
        .prepare("SELECT event_json FROM normalized_events WHERE event_id='event-redaction'")
        .get() as { event_json: string }
    ).event_json;
    assert.doesNotMatch(serialized, /must-not-persist/);
    database.close();
  });
});
