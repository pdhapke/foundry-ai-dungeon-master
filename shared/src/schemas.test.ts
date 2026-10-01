import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AI_DM_MAX_PROMPT_LENGTH,
  aiDmClientMessageSchema,
  aiDmRequestedAudienceSchema,
  aiDmTransportClientMessageSchema,
  aiDmTransportServerMessageSchema,
  parseBoundedAiDmJson,
} from "./schemas.js";

void describe("AI Dungeon Master runtime schemas", () => {
  void it("accepts a bounded strict prompt and rejects identity injection", () => {
    const valid = aiDmClientMessageSchema.parse({
      type: "aiDm.prompt.submit",
      payload: {
        requestId: "request-1",
        text: "What do I see?",
        requestedAudience: { kind: "private" },
        contextHints: {},
      },
    });
    assert.equal(valid.type, "aiDm.prompt.submit");

    assert.equal(
      aiDmClientMessageSchema.safeParse({
        type: "aiDm.prompt.submit",
        payload: {
          requestId: "request-1",
          text: "x",
          requestedAudience: { kind: "private" },
          contextHints: {},
          userId: "forged",
        },
      }).success,
      false,
    );
  });

  void it("bounds prompts and deduplicates selected audiences by rejection", () => {
    const oversized = "x".repeat(AI_DM_MAX_PROMPT_LENGTH + 1);
    assert.equal(
      aiDmClientMessageSchema.safeParse({
        type: "aiDm.prompt.submit",
        payload: {
          requestId: "request-1",
          text: oversized,
          requestedAudience: { kind: "private" },
          contextHints: {},
        },
      }).success,
      false,
    );
    assert.equal(
      aiDmRequestedAudienceSchema.safeParse({
        kind: "selected-users",
        recipientUserIds: ["user-1", "user-1"],
      }).success,
      false,
    );
  });

  void it("accepts safe model slugs and rejects path-shaped model selections", () => {
    assert.equal(
      aiDmClientMessageSchema.safeParse({
        type: "aiDm.chatgpt.model.select",
        payload: { requestId: "request-1", model: "gpt-5.4-mini" },
      }).success,
      true,
    );
    assert.equal(
      aiDmClientMessageSchema.safeParse({
        type: "aiDm.chatgpt.model.select",
        payload: { requestId: "request-1", model: "../../secret" },
      }).success,
      false,
    );
  });

  void it("rejects oversized recursive JSON", () => {
    assert.throws(() => parseBoundedAiDmJson({ value: "x".repeat(130_000) }));
  });

  void it("rejects malformed nested server delivery payloads", () => {
    assert.equal(
      aiDmTransportServerMessageSchema.safeParse({
        type: "aiDm.delivery",
        payload: {
          protocolVersion: 2,
          deliveryId: "delivery-1",
          recipientUserId: "user-1",
          recipientSequence: 1,
          worldId: "world-1",
          threadId: "thread-1",
          runId: "run-1",
          occurredAt: "2026-09-29T00:00:00.000Z",
          message: {
            type: "aiDm.output.delta",
            payload: { runId: "run-1", delta: 42 },
          },
        },
      }).success,
      false,
    );
  });

  void it("accepts bounded automatic-auth messages and rejects browser role claims", () => {
    assert.equal(
      aiDmTransportClientMessageSchema.safeParse({
        type: "aiDm.auth.identify",
        payload: {
          protocolVersion: 2,
          clientId: "client-1",
          browserSessionId: "browser-session-1",
          worldId: "world-1",
          moduleVersion: "0.1.0",
        },
      }).success,
      true,
    );
    assert.equal(
      aiDmTransportClientMessageSchema.safeParse({
        type: "aiDm.auth.identify",
        payload: {
          protocolVersion: 2,
          clientId: "client-1",
          browserSessionId: "browser-session-1",
          worldId: "world-1",
          moduleVersion: "0.1.0",
          isGm: true,
        },
      }).success,
      false,
    );
  });
});
