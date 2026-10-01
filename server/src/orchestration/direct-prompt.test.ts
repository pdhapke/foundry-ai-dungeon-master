/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AiDmAuthenticatedIdentity,
  AiDmContinuationCapsule,
  AiDmContextReceipt,
  AiDmRunPrincipal,
  AiDmRuntimeProjection,
  AiDmServerDelivery,
} from "@foundry-ai-dungeon-master/shared";

import { openStorageDatabase } from "../storage/database.js";
import { AiDmOperationalStore } from "../storage/operational-store.js";
import { AiDmProviderError } from "../runner/types.js";
import {
  DirectPromptOrchestrator,
  type AiDmAuthoritativeProjection,
  type AiDmRunExecutor,
} from "./direct-prompt.js";

const now = "2026-09-29T12:00:00.000Z";
const identity: AiDmAuthenticatedIdentity = {
  clientId: "client-1",
  userId: "user-1",
  worldId: "world-1",
  lane: "player",
  isGm: false,
};

function authority(eventId: string, authenticated = identity): AiDmAuthoritativeProjection {
  const principal: AiDmRunPrincipal = {
    ...authenticated,
    connectionId: "connection-1",
    role: authenticated.isGm ? 4 : 1,
    authorizedAudienceKinds: authenticated.isGm
      ? ["private", "gm", "selected-users", "table"]
      : ["private", "gm"],
    permissionSnapshotRevision: "permissions-1",
  };
  const projection: AiDmRuntimeProjection = {
    projectionId: `projection-${eventId}`,
    eventId,
    revision: "projection-revision-1",
    capturedAt: now,
    worldId: authenticated.worldId,
    authoritativeUserId: authenticated.userId,
    permissionRole: principal.role,
    activeSceneId: "scene-1",
    controlledTokenIds: ["token-1"],
    controlledActorIds: ["actor-1"],
    targetTokenIds: [],
    activeCombatId: null,
    activeCombatantId: null,
    activeCombatantTokenId: null,
    activeCombatantActorId: null,
    combatRound: null,
    combatTurn: null,
    campaignStateRevision: "campaign-1",
    sourceRevisions: { foundry: "foundry-1" },
    selectedDocumentUuids: [],
  };
  return { principal, projection, activeUserIds: [authenticated.userId], gmUserIds: ["gm-1"] };
}

function result(
  runId: string,
  eventId: string,
  threadId: string,
): {
  receipt: AiDmContextReceipt;
  capsule: AiDmContinuationCapsule;
} {
  return {
    receipt: {
      receiptId: `receipt-${runId}`,
      runId,
      contextGraphRevision: "graph-1",
      entries: [],
      readsUsed: 0,
      nodesUsed: 0,
      charactersUsed: 0,
      estimatedTokensUsed: 0,
      maximumDepthUsed: 0,
      budgetExhausted: false,
      completedAt: now,
    },
    capsule: {
      capsuleId: `capsule-${runId}`,
      threadId,
      worldId: "world-1",
      principalUserId: "user-1",
      disclosureScope: { kind: "users", userIds: ["user-1"] },
      priorRunId: runId,
      priorEventId: eventId,
      createdAt: now,
      expiresAt: "2026-09-29T13:00:00.000Z",
      visibility: "player",
      summary: "The AI Dungeon Master answered the prompt.",
      unresolvedReferences: [],
      sourceNodeRevisions: [],
      checksum: "checksum-1",
      signature: "signature-1",
    },
  };
}

void describe("direct prompt orchestration", () => {
  void it("durably normalizes a private prompt, starts one fresh run, and delivers a result", async () => {
    const database = await openStorageDatabase({ path: ":memory:" });
    const store = new AiDmOperationalStore(database.connection);
    const deliveries: AiDmServerDelivery[] = [];
    let executions = 0;
    const executor: AiDmRunExecutor = {
      execute: async ({ run, event, hooks }) => {
        executions += 1;
        await hooks.status("resolving");
        await hooks.providerResponse("response-success-1");
        await hooks.providerResponse("response-success-2");
        await hooks.output("A safe answer.");
        return {
          finalText: "A safe answer.",
          ...result(run.runId, event.eventId, run.threadId),
        };
      },
    };
    const orchestrator = new DirectPromptOrchestrator(
      store,
      { project: async ({ event }) => authority(event.eventId) },
      executor,
      { deliver: (delivery) => deliveries.push(delivery) },
      () => new Date(now),
    );
    const command = {
      type: "aiDm.prompt.submit" as const,
      payload: {
        requestId: "request-1",
        text: "What is in the room?",
        requestedAudience: { kind: "private" as const },
        contextHints: { sceneId: "scene-1" },
      },
    };
    await orchestrator.handle(command, identity);
    await orchestrator.handle(command, identity);

    assert.equal(executions, 1, "duplicate delivery must not start another model run");
    assert.equal(
      deliveries.some(({ message }) => message.type === "aiDm.run.acknowledged"),
      true,
    );
    assert.equal(
      deliveries.some(
        ({ message }) =>
          message.type === "aiDm.message.created" && message.payload.kind === "narration",
      ),
      true,
    );
    const persisted = store.getEventByDeduplicationKey(
      "world-1",
      "prompt:user-1:request-1",
      "user-1",
      false,
    );
    assert.equal(persisted?.eventType, "player.prompt.submitted");
    const runDelivery = deliveries.find(({ message }) => message.type === "aiDm.run.completed");
    assert.ok(runDelivery?.runId);
    assert.equal(
      runDelivery?.message.type === "aiDm.run.completed"
        ? runDelivery.message.payload.diagnostics
        : undefined,
      undefined,
      "player completion payloads must not expose context receipts or continuation capsules",
    );
    const persistedRun = store.getRun(runDelivery.runId);
    assert.equal(persistedRun?.status, "complete");
    assert.equal(persistedRun?.providerResponseId, "response-success-1");
    assert.equal(persistedRun?.providerResponseRunBinding, runDelivery.runId);
    database.close();
  });

  void it("rejects unauthorized audience escalation before recording an event", async () => {
    const database = await openStorageDatabase({ path: ":memory:" });
    const store = new AiDmOperationalStore(database.connection);
    const executor: AiDmRunExecutor = {
      execute: () => Promise.reject(new Error("must not execute")),
    };
    const orchestrator = new DirectPromptOrchestrator(
      store,
      { project: async ({ event }) => authority(event.eventId) },
      executor,
      { deliver: () => undefined },
      () => new Date(now),
    );
    await assert.rejects(
      orchestrator.handle(
        {
          type: "aiDm.prompt.submit",
          payload: {
            requestId: "request-escalation",
            text: "Broadcast this",
            requestedAudience: { kind: "table" },
            contextHints: {},
          },
        },
        identity,
      ),
      /not authorized/,
    );
    assert.equal(
      store.getEventByDeduplicationKey(
        "world-1",
        "prompt:user-1:request-escalation",
        "user-1",
        false,
      ),
      null,
    );
    database.close();
  });

  void it("allows only the run owner or a same-world GM to cancel a run", async () => {
    const database = await openStorageDatabase({ path: ":memory:" });
    const store = new AiDmOperationalStore(database.connection);
    const deliveries: AiDmServerDelivery[] = [];
    let signal: AbortSignal | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const executor: AiDmRunExecutor = {
      execute: ({ signal: runSignal }) => {
        signal = runSignal;
        startedResolve?.();
        return new Promise((_resolve, reject) => {
          runSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    };
    const orchestrator = new DirectPromptOrchestrator(
      store,
      { project: async ({ event }) => authority(event.eventId) },
      executor,
      { deliver: (delivery) => deliveries.push(delivery) },
      () => new Date(now),
    );
    const prompt = orchestrator.handle(
      {
        type: "aiDm.prompt.submit",
        payload: {
          requestId: "request-cancel",
          text: "Wait for cancellation.",
          requestedAudience: { kind: "private" },
          contextHints: {},
        },
      },
      identity,
    );
    await started;
    const acknowledgement = deliveries.find(
      ({ message }) => message.type === "aiDm.run.acknowledged",
    );
    assert.ok(acknowledgement?.runId);
    const cancel = {
      type: "aiDm.run.cancel" as const,
      payload: { requestId: "cancel-1", runId: acknowledgement.runId },
    };
    await assert.rejects(
      orchestrator.handle(cancel, {
        ...identity,
        clientId: "client-2",
        userId: "user-2",
      }),
      /not authorized/,
    );
    assert.equal(signal?.aborted, false);

    await orchestrator.handle(cancel, identity);
    await prompt;
    assert.equal(signal?.aborted, true);
    assert.equal(store.getRun(acknowledgement.runId)?.status, "cancelled");
    database.close();
  });

  void it("persists a GM table result into recipient-specific transcripts", async () => {
    const database = await openStorageDatabase({ path: ":memory:" });
    const store = new AiDmOperationalStore(database.connection);
    const gmIdentity: AiDmAuthenticatedIdentity = {
      ...identity,
      clientId: "gm-client",
      userId: "gm-1",
      lane: "gm",
      isGm: true,
    };
    const deliveries: AiDmServerDelivery[] = [];
    const orchestrator = new DirectPromptOrchestrator(
      store,
      {
        project: async ({ event }) => ({
          ...authority(event.eventId, gmIdentity),
          activeUserIds: ["gm-1", "player-2"],
          gmUserIds: ["gm-1"],
        }),
      },
      {
        execute: async ({ run, event, hooks }) => {
          await hooks.status("resolving");
          return {
            finalText: "The chamber fills with harmless silver light.",
            ...result(run.runId, event.eventId, run.threadId),
          };
        },
      },
      { deliver: (delivery) => deliveries.push(delivery) },
      () => new Date(now),
    );
    await orchestrator.handle(
      {
        type: "aiDm.prompt.submit",
        payload: {
          requestId: "request-public",
          text: "Narrate the chamber to the table.",
          requestedAudience: { kind: "table" },
          contextHints: {},
        },
      },
      gmIdentity,
    );

    const playerThread = store.resolveActiveThread("player-2", {
      worldId: "world-1",
      requesterUserId: "player-2",
      requesterIsGm: false,
    });
    assert.ok(playerThread);
    const history = store.fetchHistory({
      threadId: playerThread.threadId,
      worldId: "world-1",
      requesterUserId: "player-2",
      requesterIsGm: false,
      limit: 20,
    });
    assert.deepEqual(
      history.messages.map(({ kind }) => kind),
      ["narration"],
      "another user receives only the safe public narration, not the GM prompt or diagnostics",
    );
    assert.equal(
      deliveries.some(
        ({ recipientUserId, message }) =>
          recipientUserId === "player-2" &&
          message.type === "aiDm.message.created" &&
          message.payload.deliveryClass === "public",
      ),
      true,
    );
    assert.equal(
      deliveries.some(
        ({ recipientUserId, message }) =>
          recipientUserId === "player-2" && message.type === "aiDm.run.completed",
      ),
      false,
    );
    database.close();
  });

  void it("delivers terminal cleanup to every recipient without exposing GM diagnostics", async () => {
    const database = await openStorageDatabase({ path: ":memory:" });
    const store = new AiDmOperationalStore(database.connection);
    const gmIdentity: AiDmAuthenticatedIdentity = {
      ...identity,
      clientId: "gm-client",
      userId: "gm-1",
      lane: "gm",
      isGm: true,
    };
    const deliveries: AiDmServerDelivery[] = [];
    const orchestrator = new DirectPromptOrchestrator(
      store,
      {
        project: async ({ event }) => ({
          ...authority(event.eventId, gmIdentity),
          activeUserIds: ["gm-1", "player-2"],
          gmUserIds: ["gm-1"],
        }),
      },
      {
        execute: async ({ hooks }) => {
          await hooks.status("resolving");
          await hooks.output("partial");
          throw new AiDmProviderError({
            code: "PROVIDER_RESPONSE_FAILED",
            message: "The provider reported a safe terminal failure.",
            requestAccepted: true,
            retryable: false,
            httpStatus: 200,
            requestId: "req-safe-table",
            terminalEventType: "response.failed",
          });
        },
      },
      { deliver: (delivery) => deliveries.push(delivery) },
      () => new Date(now),
    );

    await orchestrator.handle(
      {
        type: "aiDm.prompt.submit",
        payload: {
          requestId: "request-table-failure",
          text: "Narrate safely.",
          requestedAudience: { kind: "selected-users", recipientUserIds: ["player-2"] },
          contextHints: {},
        },
      },
      gmIdentity,
    );

    assert.equal(
      deliveries.some(
        ({ recipientUserId, message }) =>
          recipientUserId === "gm-1" && message.type === "aiDm.output.delta",
      ),
      false,
    );
    assert.equal(
      deliveries.some(
        ({ recipientUserId, message }) =>
          recipientUserId === "player-2" && message.type === "aiDm.output.delta",
      ),
      true,
    );
    for (const recipient of ["gm-1", "player-2"]) {
      const failure = deliveries.find(
        ({ recipientUserId, message }) =>
          recipientUserId === recipient && message.type === "aiDm.run.failed",
      );
      assert.ok(failure?.message.type === "aiDm.run.failed");
      assert.equal(Boolean(failure.message.payload.diagnostics), recipient === "gm-1");
    }
    const playerThread = store.resolveActiveThread("player-2", {
      worldId: "world-1",
      requesterUserId: "player-2",
      requesterIsGm: false,
    });
    assert.ok(playerThread);
    const playerHistory = store.fetchHistory({
      threadId: playerThread.threadId,
      worldId: "world-1",
      requesterUserId: "player-2",
      requesterIsGm: false,
      limit: 20,
    });
    assert.equal(playerHistory.runs.length, 1);
    assert.equal(playerHistory.runs[0]?.status, "failed");
    assert.equal(playerHistory.runs[0]?.failureCode, "PROVIDER_RESPONSE_FAILED");
    database.close();
  });

  void it("routes an authenticated automatic combat event through the same durable run path", async () => {
    const database = await openStorageDatabase({ path: ":memory:" });
    const store = new AiDmOperationalStore(database.connection);
    const gmIdentity: AiDmAuthenticatedIdentity = {
      ...identity,
      clientId: "gm-client",
      userId: "gm-1",
      lane: "gm",
      isGm: true,
    };
    let observedEventType = "";
    const orchestrator = new DirectPromptOrchestrator(
      store,
      {
        project: async ({ event }) => {
          observedEventType = event.eventType;
          return authority(event.eventId, gmIdentity);
        },
      },
      {
        execute: async ({ run, event, hooks }) => {
          await hooks.status("resolving");
          return {
            finalText: "The next combatant is ready.",
            ...result(run.runId, event.eventId, run.threadId),
          };
        },
      },
      { deliver: () => undefined },
      () => new Date(now),
    );
    await orchestrator.handle(
      {
        type: "aiDm.event.submit",
        payload: {
          requestId: "automatic-1",
          eventType: "combat.turn.changed",
          sourceCorrelationId: "combat-1:round-2:turn-1",
          presentation: "collapsed",
          contextHints: { sceneId: "scene-1" },
          payload: { combatId: "combat-1", round: 2, turn: 1 },
        },
      },
      gmIdentity,
    );
    assert.equal(observedEventType, "combat.turn.changed");
    const event = store.getEventByDeduplicationKey(
      "world-1",
      "combat.turn.changed:gm-1:automatic-1",
      "gm-1",
      true,
    );
    assert.equal(event?.source, "foundry-hook");
    const thread = store.resolveActiveThread("gm-1", {
      worldId: "world-1",
      requesterUserId: "gm-1",
      requesterIsGm: true,
    });
    assert.ok(thread);
    assert.deepEqual(
      store
        .fetchHistory({
          threadId: thread.threadId,
          worldId: "world-1",
          requesterUserId: "gm-1",
          requesterIsGm: true,
          limit: 20,
        })
        .messages.map(({ kind }) => kind),
      ["narration"],
    );
    database.close();
  });

  void it("durably binds provider acceptance and delivers a safe deterministic GM failure", async () => {
    const database = await openStorageDatabase({ path: ":memory:" });
    const store = new AiDmOperationalStore(database.connection);
    const gmIdentity: AiDmAuthenticatedIdentity = {
      ...identity,
      clientId: "gm-client",
      userId: "gm-1",
      lane: "gm",
      isGm: true,
    };
    const deliveries: AiDmServerDelivery[] = [];
    const orchestrator = new DirectPromptOrchestrator(
      store,
      { project: async ({ event }) => authority(event.eventId, gmIdentity) },
      {
        execute: async ({ hooks }) => {
          await hooks.status("resolving");
          await hooks.providerResponse("response-accepted-1");
          throw new AiDmProviderError({
            code: "PROVIDER_RESPONSE_FAILED",
            message: "The provider reported a safe terminal failure.",
            requestAccepted: true,
            retryable: false,
            terminalEventType: "response.failed",
          });
        },
      },
      { deliver: (delivery) => deliveries.push(delivery) },
      () => new Date(now),
    );

    await orchestrator.handle(
      {
        type: "aiDm.prompt.submit",
        payload: {
          requestId: "request-provider-failure",
          text: "Make a safe provider request.",
          requestedAudience: { kind: "private" },
          contextHints: {},
        },
      },
      gmIdentity,
    );

    const failure = deliveries.find(({ message }) => message.type === "aiDm.run.failed");
    assert.ok(failure?.runId);
    assert.equal(failure.recipientUserId, gmIdentity.userId);
    assert.deepEqual(failure.message.type === "aiDm.run.failed" ? failure.message.payload : null, {
      runId: failure.runId,
      code: "PROVIDER_RESPONSE_FAILED",
      message: "The provider reported a safe terminal failure.",
      retryable: false,
      diagnostics: { terminalEventType: "response.failed" },
    });
    const persisted = store.getRun(failure.runId);
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.failureCode, "PROVIDER_RESPONSE_FAILED");
    assert.equal(persisted?.providerResponseId, "response-accepted-1");
    assert.equal(persisted?.providerResponseRunBinding, failure.runId);
    database.close();
  });
});
