import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AI_DM_PROTOCOL_VERSION, type AiDmServerDelivery } from "@foundry-ai-dungeon-master/shared";

import { AiDmClientStore } from "./store.js";

function delivery(sequence: number, messageId: string): AiDmServerDelivery {
  return {
    protocolVersion: AI_DM_PROTOCOL_VERSION,
    deliveryId: `delivery-${sequence}`,
    recipientUserId: "user-1",
    recipientSequence: sequence,
    worldId: "world-1",
    threadId: "thread-1",
    runId: "run-1",
    occurredAt: "2026-09-29T00:00:00.000Z",
    message: {
      type: "aiDm.message.created",
      payload: {
        messageId,
        threadId: "thread-1",
        threadSequence: sequence,
        runId: "run-1",
        eventId: "event-1",
        kind: "narration",
        deliveryClass: "private",
        effectiveAudience: {
          scope: { kind: "users", userIds: ["user-1"] },
          transcript: true,
          mirrorToFoundryChat: false,
        },
        createdAt: "2026-09-29T00:00:00.000Z",
        content: { kind: "plain-text", text: "Safe output" },
      },
    },
  };
}

void describe("AI Dungeon Master client store", () => {
  void it("deduplicates deliveries and detects reconnect gaps", () => {
    const store = new AiDmClientStore();
    assert.equal(store.applyDelivery(delivery(1, "message-1")), "applied");
    assert.equal(store.applyDelivery(delivery(1, "message-1")), "duplicate");
    assert.equal(store.applyDelivery(delivery(3, "message-3")), "gap");
    assert.equal(store.state.messages.length, 1);
    assert.equal(store.state.lastRecipientSequence, 1);
  });

  void it("restores ordered history without duplicating message IDs", () => {
    const store = new AiDmClientStore();
    store.applyDelivery(delivery(1, "message-1"));
    const first = delivery(1, "message-1").message;
    const second = delivery(2, "message-2").message;
    if (first.type !== "aiDm.message.created" || second.type !== "aiDm.message.created") {
      assert.fail("Expected message deliveries.");
    }
    const history = delivery(2, "ignored-envelope-message");
    history.message = {
      type: "aiDm.history.result",
      payload: {
        requestId: "request-1",
        threadId: "thread-1",
        messages: [first.payload, second.payload],
        hasMore: false,
      },
    };
    assert.equal(store.applyDelivery(history), "applied");
    assert.deepEqual(
      store.state.messages.map(({ messageId }) => messageId),
      ["message-1", "message-2"],
    );
  });

  void it("assembles ordered output deltas and records approval cards", () => {
    const store = new AiDmClientStore();
    const first = delivery(1, "unused-1");
    first.message = {
      type: "aiDm.output.delta",
      payload: {
        runId: "run-1",
        messageId: "stream-1",
        deltaSequence: 1,
        offset: 0,
        messageRevision: 1,
        delta: "Hello ",
        final: false,
      },
    };
    const second = delivery(2, "unused-2");
    second.message = {
      type: "aiDm.output.delta",
      payload: {
        runId: "run-1",
        messageId: "stream-1",
        deltaSequence: 2,
        offset: 6,
        messageRevision: 2,
        delta: "there",
        final: true,
      },
    };
    const approval = delivery(3, "unused-3");
    approval.message = {
      type: "aiDm.approval.required",
      payload: {
        proposalId: "proposal-1",
        proposalRevision: "0123456789abcdef",
        summary: "Create a synthetic Token",
        expiresAt: "2026-09-29T01:00:00.000Z",
        operationSummaries: ["Create Token"],
        approvalAuthority: { kind: "gm" },
      },
    };
    store.applyDelivery(first);
    store.applyDelivery(second);
    store.applyDelivery(approval);
    assert.equal(store.state.outputStreams.get("stream-1")?.text, "Hello there");
    assert.equal(store.state.approvals.get("proposal-1")?.summary, "Create a synthetic Token");
  });

  void it("preserves safe failure details and removes partial output on terminal delivery", () => {
    const store = new AiDmClientStore();
    const partial = delivery(1, "unused-partial");
    partial.message = {
      type: "aiDm.output.delta",
      payload: {
        runId: "run-1",
        messageId: "stream-1",
        deltaSequence: 1,
        offset: 0,
        messageRevision: 1,
        delta: "Unfinished output",
        final: false,
      },
    };
    const failure = delivery(2, "unused-failure");
    failure.message = {
      type: "aiDm.run.failed",
      payload: {
        runId: "run-1",
        code: "PROVIDER_RECONNECT_REQUIRED",
        message: "Reconnect ChatGPT and select an eligible model.",
        retryable: false,
      },
    };

    assert.equal(store.applyDelivery(partial), "applied");
    assert.equal(store.state.outputStreams.size, 1);
    assert.equal(store.applyDelivery(failure), "applied");
    assert.equal(store.state.runStatuses.get("run-1"), "failed");
    assert.deepEqual(store.state.runFailures.get("run-1"), {
      code: "PROVIDER_RECONNECT_REQUIRED",
      message: "Reconnect ChatGPT and select an eligible model.",
      retryable: false,
    });
    assert.equal(store.state.outputStreams.size, 0);
  });

  void it("removes partial output and stale failure details when a run completes", () => {
    const store = new AiDmClientStore();
    const failed = delivery(1, "unused-failed");
    failed.message = {
      type: "aiDm.run.failed",
      payload: {
        runId: "run-1",
        code: "SAFE_FAILURE",
        message: "The request failed safely.",
        retryable: true,
      },
    };
    const completed = delivery(2, "unused-completed");
    completed.message = {
      type: "aiDm.run.completed",
      payload: { runId: "run-1" },
    };

    store.applyDelivery(failed);
    assert.equal(store.state.runFailures.has("run-1"), true);
    store.applyDelivery(completed);
    assert.equal(store.state.runStatuses.get("run-1"), "complete");
    assert.equal(store.state.runFailures.has("run-1"), false);
  });

  void it("accepts an authenticated history snapshot as a recipient cursor baseline", () => {
    const store = new AiDmClientStore();
    const snapshot = delivery(5, "unused");
    const message = delivery(1, "message-1").message;
    if (message.type !== "aiDm.message.created") assert.fail("Expected message delivery.");
    snapshot.message = {
      type: "aiDm.history.result",
      payload: {
        requestId: "request-history",
        threadId: "thread-1",
        messages: [message.payload],
        runs: [{ runId: "run-history", status: "failed", failureCode: "PROVIDER_HTTP_ERROR" }],
        hasMore: false,
      },
    };
    assert.equal(store.applyDelivery(snapshot), "applied");
    assert.equal(store.state.lastRecipientSequence, 5);
    assert.equal(store.state.messages.length, 1);
    assert.equal(store.state.runStatuses.get("run-history"), "failed");
    assert.equal(store.state.runFailures.get("run-history")?.code, "PROVIDER_HTTP_ERROR");
  });

  void it("does not advance the recipient cursor for a malformed stream delta", () => {
    const store = new AiDmClientStore();
    const malformed = delivery(1, "unused");
    malformed.message = {
      type: "aiDm.output.delta",
      payload: {
        runId: "run-1",
        messageId: "stream-1",
        deltaSequence: 2,
        offset: 9,
        messageRevision: 1,
        delta: "bad",
        final: false,
      },
    };
    assert.equal(store.applyDelivery(malformed), "gap");
    assert.equal(store.state.lastRecipientSequence, 0);
    assert.equal(store.state.outputStreams.size, 0);
  });

  void it("requires an eligible selected model before marking ChatGPT inference ready", () => {
    const store = new AiDmClientStore();
    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-model-status-1",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "available",
        availableModels: [{ slug: "gpt-5.4", displayName: "GPT-5.4" }],
        selectedModel: null,
      },
    });
    assert.equal(store.state.chatGpt.state, "model-unavailable");
    assert.equal(store.state.chatGpt.planUsageAuthorized, true);

    store.setModelSelectionPending(true);
    assert.equal(store.state.chatGpt.modelSelectionPending, true);
    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-model-status-2",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "available",
        availableModels: [{ slug: "gpt-5.4", displayName: "GPT-5.4" }],
        selectedModel: "gpt-5.4",
      },
    });
    assert.equal(store.state.chatGpt.state, "ready");
    assert.equal(store.state.chatGpt.selectedModel, "gpt-5.4");
    assert.equal(store.state.chatGpt.modelSelectionPending, false);

    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-model-status-3",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "unavailable",
        availableModels: [],
        selectedModel: null,
      },
    });
    assert.equal(store.state.chatGpt.state, "model-unavailable");
    assert.equal(store.state.chatGpt.modelDiscoveryState, "unavailable");

    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-model-status-4",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "empty",
        availableModels: [],
        selectedModel: null,
      },
    });
    assert.equal(store.state.chatGpt.state, "model-unavailable");
    assert.equal(store.state.chatGpt.modelDiscoveryState, "empty");
  });

  void it("clears authoritative model readiness on a reconnect-required provider failure", () => {
    const store = new AiDmClientStore();
    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-ready",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "available",
        availableModels: [{ slug: "gpt-ready", displayName: "GPT Ready" }],
        selectedModel: "gpt-ready",
      },
    });
    assert.equal(store.state.chatGpt.state, "ready");

    const failure = delivery(1, "unused-failure");
    failure.message = {
      type: "aiDm.run.failed",
      payload: {
        runId: "run-reconnect",
        code: "PROVIDER_RECONNECT_REQUIRED",
        message: "Reconnect ChatGPT and select an eligible model.",
        retryable: false,
        diagnostics: { httpStatus: 401, requestId: "req-safe" },
      },
    };
    assert.equal(store.applyDelivery(failure), "applied");
    assert.equal(store.state.chatGpt.state, "signed-out");
    assert.equal(store.state.chatGpt.selectedModel, null);
    assert.deepEqual(store.state.runFailures.get("run-reconnect")?.diagnostics, {
      httpStatus: 401,
      requestId: "req-safe",
    });
  });
});
