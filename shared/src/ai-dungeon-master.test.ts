import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AI_DM_PROTOCOL_VERSION,
  AI_DM_TERMINAL_RUN_STATUSES,
  isAiDmTerminalRunStatus,
  type AiDmClientMessage,
  type AiDmRun,
} from "./ai-dungeon-master.js";

void describe("AI Dungeon Master shared contract", () => {
  void it("has an explicit version and closed terminal statuses", () => {
    assert.equal(AI_DM_PROTOCOL_VERSION, 2);
    assert.deepEqual(AI_DM_TERMINAL_RUN_STATUSES, ["complete", "failed", "cancelled"]);
    assert.equal(isAiDmTerminalRunStatus("complete"), true);
    assert.equal(isAiDmTerminalRunStatus("resolving"), false);
  });

  void it("keeps prompt identity out of the client-supplied payload", () => {
    const message: AiDmClientMessage = {
      type: "aiDm.prompt.submit",
      payload: {
        requestId: "request-1",
        text: "What do I see?",
        requestedAudience: { kind: "private" },
        contextHints: { controlledTokenIds: ["token-1"] },
      },
    };

    assert.equal("userId" in message.payload, false);
    assert.equal("isGm" in message.payload, false);
  });

  void it("binds a provider continuation to one run record", () => {
    const run: AiDmRun = {
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
        permissionSnapshotRevision: "permissions-1",
      },
      attempt: 1,
      status: "resolving",
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      providerResponseId: "response-within-run-only",
      providerResponseRunBinding: "run-1",
      budgets: {
        context: {
          maxReads: 12,
          maxDepth: 4,
          maxNodes: 48,
          maxCharacters: 120_000,
          maxEstimatedTokens: 24_000,
        },
        maxToolSearches: 8,
        maxLoadedDefinitions: 12,
        maxToolCalls: 16,
        maxProposalOperations: 12,
        maxOutputCharacters: 40_000,
        maxProviderAttempts: 3,
        maxWallClockMs: 120_000,
      },
      statusRevision: 1,
      cancelRequestedAt: null,
      failureCode: null,
    };

    assert.equal(run.eventId, "event-1");
    assert.equal(run.providerResponseId, "response-within-run-only");
  });
});
