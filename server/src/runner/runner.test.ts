/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AiDmNormalizedEvent,
  AiDmRun,
  AiDmRuntimeProjection,
} from "@foundry-ai-dungeon-master/shared";

import { DeterministicAiDmProvider } from "./mock-provider.js";
import { AiDungeonMasterRunner, AiDmRunnerError } from "./runner.js";
import { AiDmProviderError } from "./types.js";

function fixtureRun(): AiDmRun {
  return {
    runId: "run-1",
    eventId: "event-1",
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
      permissionSnapshotRevision: "permission-1",
    },
    attempt: 1,
    status: "queued",
    statusRevision: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    providerResponseId: null,
    providerResponseRunBinding: null,
    budgets: {
      context: {
        maxReads: 12,
        maxDepth: 3,
        maxNodes: 32,
        maxCharacters: 64_000,
        maxEstimatedTokens: 16_000,
      },
      maxToolSearches: 8,
      maxLoadedDefinitions: 12,
      maxToolCalls: 16,
      maxProposalOperations: 12,
      maxOutputCharacters: 40_000,
      maxProviderAttempts: 3,
      maxWallClockMs: 120_000,
    },
    cancelRequestedAt: null,
    failureCode: null,
  };
}

const event = {
  schemaVersion: 1,
  eventId: "event-1",
  sequence: 1,
  eventType: "player.prompt.submitted",
  source: "direct-prompt",
  occurredAt: "2026-09-29T00:00:00.000Z",
  receivedAt: "2026-09-29T00:00:00.000Z",
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
  payload: { text: "What do I see?" },
  payloadHash: "hash",
  sourceCorrelationId: "request-1",
  deduplicationKey: "client-1:request-1",
  sourceStateRevision: null,
} satisfies AiDmNormalizedEvent;

const projection = {
  projectionId: "projection-1",
  eventId: "event-1",
  revision: "projection-revision",
  capturedAt: "2026-09-29T00:00:00.000Z",
  worldId: "world-1",
  authoritativeUserId: "user-1",
  permissionRole: 1,
  activeSceneId: "scene-1",
  controlledTokenIds: [],
  controlledActorIds: [],
  targetTokenIds: [],
  activeCombatId: null,
  activeCombatantId: null,
  activeCombatantTokenId: null,
  activeCombatantActorId: null,
  combatRound: null,
  combatTurn: null,
  campaignStateRevision: null,
  sourceRevisions: {},
  selectedDocumentUuids: [],
} satisfies AiDmRuntimeProjection;

void describe("AI Dungeon Master runner", () => {
  void it("continues tool calls only inside one run and completes structurally", async () => {
    const provider = new DeterministicAiDmProvider([
      {
        responseId: "response-1",
        outputs: [
          {
            type: "function_call",
            callId: "call-1",
            name: "context_get_root",
            argumentsJson: "{}",
          },
        ],
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      {
        responseId: "response-2",
        outputs: [
          {
            type: "function_call",
            callId: "call-2",
            name: "run_complete",
            argumentsJson: JSON.stringify({
              finalText: "The room is quiet.",
              contextReceiptId: null,
              proposalIds: [],
            }),
          },
        ],
        usage: { inputTokens: 4, outputTokens: 6 },
      },
    ]);
    const runner = new AiDungeonMasterRunner({
      provider,
      model: "test-model",
      toolExecutor: { execute: async () => ({ output: { root: "ok" } }) },
    });

    const result = await runner.run(
      fixtureRun(),
      { event, projection, rootManifest: { id: "root" }, continuationCapsule: null },
      new AbortController().signal,
    );

    assert.equal(result.finalText, "The room is quiet.");
    assert.equal(provider.requests[0]?.previousResponseId, null);
    assert.equal(provider.requests[1]?.previousResponseId, "response-1");
    assert.equal(result.usage.inputTokens, 14);
  });

  void it("withholds provider text until a structured completion is validated", async () => {
    const delivered: string[] = [];
    const provider = new DeterministicAiDmProvider([
      {
        responseId: "response-unsafe-intermediate",
        outputs: [
          { type: "text", text: "unvalidated intermediate text" },
          {
            type: "function_call",
            callId: "call-complete",
            name: "run_complete",
            argumentsJson: JSON.stringify({
              finalText: "Validated final narration.",
              contextReceiptId: null,
              proposalIds: [],
            }),
          },
        ],
        usage: { inputTokens: 1, outputTokens: 4 },
      },
    ]);
    const runner = new AiDungeonMasterRunner({
      provider,
      model: "test-model",
      toolExecutor: { execute: async () => ({ output: null }) },
      hooks: { onOutputDelta: (text) => void delivered.push(text) },
    });

    await runner.run(
      fixtureRun(),
      { event, projection, rootManifest: {}, continuationCapsule: null },
      new AbortController().signal,
    );

    assert.deepEqual(delivered, ["Validated final narration."]);
  });

  void it("refuses to start a fresh run with a prior response chain", async () => {
    const run = fixtureRun();
    run.providerResponseId = "response-from-other-event";
    run.providerResponseRunBinding = "run-other";
    const runner = new AiDungeonMasterRunner({
      provider: new DeterministicAiDmProvider([]),
      model: "test-model",
      toolExecutor: { execute: async () => ({ output: null }) },
    });

    await assert.rejects(
      runner.run(
        run,
        { event, projection, rootManifest: {}, continuationCapsule: null },
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof AiDmRunnerError && error.code === "PROVIDER_MALFORMED_OUTPUT",
    );
  });

  void it("returns typed cancellation without calling the provider", async () => {
    const provider = new DeterministicAiDmProvider([]);
    const runner = new AiDungeonMasterRunner({
      provider,
      model: "test-model",
      toolExecutor: { execute: async () => ({ output: null }) },
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      runner.run(
        fixtureRun(),
        { event, projection, rootManifest: {}, continuationCapsule: null },
        controller.signal,
      ),
      (error: unknown) => error instanceof AiDmRunnerError && error.code === "RUN_CANCELLED",
    );
    assert.equal(provider.requests.length, 0);
  });

  void it("retries only an explicitly pre-dispatch failure within the attempt budget", async () => {
    let attempts = 0;
    const runner = new AiDungeonMasterRunner({
      provider: {
        createResponse: () => {
          attempts += 1;
          if (attempts < 3)
            return Promise.reject(
              new AiDmProviderError({
                code: "PROVIDER_STREAM_ERROR",
                message: "The provider could not be reached before dispatch.",
                requestAccepted: false,
                retryable: true,
              }),
            );
          return Promise.resolve({
            responseId: "response-after-retry",
            outputs: [
              {
                type: "function_call" as const,
                callId: "call-complete",
                name: "run_complete",
                argumentsJson: JSON.stringify({
                  finalText: "Recovered safely.",
                  contextReceiptId: null,
                  proposalIds: [],
                }),
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        },
      },
      model: "test-model",
      toolExecutor: { execute: async () => ({ output: null }) },
    });
    const result = await runner.run(
      fixtureRun(),
      { event, projection, rootManifest: {}, continuationCapsule: null },
      new AbortController().signal,
    );
    assert.equal(result.finalText, "Recovered safely.");
    assert.equal(attempts, 3);
  });

  void it("does not duplicate a request after an accepted or ambiguous provider failure", async () => {
    for (const code of ["PROVIDER_STREAM_INTERRUPTED", "PROVIDER_TIMEOUT"] as const) {
      let attempts = 0;
      const acceptedIds: string[] = [];
      const failure = new AiDmProviderError({
        code,
        message: "The accepted provider request did not complete safely.",
        requestAccepted: true,
        retryable: false,
        providerResponseId: `response-${code}`,
      });
      const runner = new AiDungeonMasterRunner({
        provider: {
          createResponse: () => {
            attempts += 1;
            return Promise.reject(failure);
          },
        },
        model: "test-model",
        toolExecutor: { execute: async () => ({ output: null }) },
        hooks: { onProviderResponse: (responseId) => void acceptedIds.push(responseId) },
      });

      await assert.rejects(
        runner.run(
          fixtureRun(),
          { event, projection, rootManifest: {}, continuationCapsule: null },
          new AbortController().signal,
        ),
        (error: unknown) => error === failure,
      );
      assert.equal(attempts, 1, `${code} must not be retried`);
      assert.deepEqual(acceptedIds, [`response-${code}`]);
    }
  });

  void it("does not retry an unclassified provider failure", async () => {
    let attempts = 0;
    const runner = new AiDungeonMasterRunner({
      provider: {
        createResponse: () => {
          attempts += 1;
          return Promise.reject(new Error("unclassified"));
        },
      },
      model: "test-model",
      toolExecutor: { execute: async () => ({ output: null }) },
    });

    await assert.rejects(
      runner.run(
        fixtureRun(),
        { event, projection, rootManifest: {}, continuationCapsule: null },
        new AbortController().signal,
      ),
      /unclassified/,
    );
    assert.equal(attempts, 1);
  });
});
