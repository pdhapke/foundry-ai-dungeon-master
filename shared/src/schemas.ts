import { z } from "zod";

import { AI_DM_PROTOCOL_VERSION } from "./ai-dungeon-master.js";

export const AI_DM_MAX_ID_LENGTH = 160;
export const AI_DM_MAX_PROMPT_LENGTH = 20_000;
export const AI_DM_MAX_SELECTED_IDS = 64;
export const AI_DM_MAX_SELECTED_USERS = 32;
export const AI_DM_MAX_JSON_CHARACTERS = 128_000;

export const aiDmIdSchema = z
  .string()
  .min(1)
  .max(AI_DM_MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9._:/-]+$/);

export const aiDmIsoTimestampSchema = z.string().datetime({ offset: true });

const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const aiDmJsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(aiDmJsonValueSchema).max(128),
    z.record(z.string().min(1).max(160), aiDmJsonValueSchema).superRefine((value, context) => {
      if (Object.keys(value).length > 128) {
        context.addIssue({ code: "custom", message: "Object has too many fields." });
      }
    }),
  ]),
);

export function parseBoundedAiDmJson(value: unknown): unknown {
  const parsed = aiDmJsonValueSchema.parse(value);
  if (JSON.stringify(parsed).length > AI_DM_MAX_JSON_CHARACTERS) {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "JSON payload exceeds the maximum serialized size.",
      },
    ]);
  }
  return parsed;
}

export const aiDmRequestedAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("private") }).strict(),
  z.object({ kind: z.literal("gm") }).strict(),
  z
    .object({
      kind: z.literal("selected-users"),
      recipientUserIds: z.array(aiDmIdSchema).min(1).max(AI_DM_MAX_SELECTED_USERS),
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set(value.recipientUserIds).size !== value.recipientUserIds.length) {
        context.addIssue({
          code: "custom",
          path: ["recipientUserIds"],
          message: "Duplicate user.",
        });
      }
    }),
  z.object({ kind: z.literal("table") }).strict(),
]);

const contextHintsSchema = z
  .object({
    sceneId: aiDmIdSchema.optional(),
    controlledTokenIds: z.array(aiDmIdSchema).max(AI_DM_MAX_SELECTED_IDS).optional(),
    controlledActorIds: z.array(aiDmIdSchema).max(AI_DM_MAX_SELECTED_IDS).optional(),
    targetTokenIds: z.array(aiDmIdSchema).max(AI_DM_MAX_SELECTED_IDS).optional(),
    selectedDocumentUuids: z
      .array(z.string().min(1).max(512))
      .max(AI_DM_MAX_SELECTED_IDS)
      .optional(),
  })
  .strict();

const promptSubmitSchema = z
  .object({
    requestId: aiDmIdSchema,
    text: z.string().trim().min(1).max(AI_DM_MAX_PROMPT_LENGTH),
    requestedAudience: aiDmRequestedAudienceSchema,
    contextHints: contextHintsSchema,
  })
  .strict();

const approvalRequestSchema = z
  .object({
    requestId: aiDmIdSchema,
    proposalId: aiDmIdSchema,
    decision: z.enum(["approve", "refuse"]),
    proposalRevision: z.string().min(16).max(256),
  })
  .strict();

export const aiDmClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("aiDm.chatgpt.signin.begin"),
      payload: z.object({ requestId: aiDmIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.chatgpt.status"),
      payload: z.object({ requestId: aiDmIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.chatgpt.model.select"),
      payload: z
        .object({
          requestId: aiDmIdSchema,
          model: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z0-9._:-]+$/),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.chatgpt.signout"),
      payload: z.object({ requestId: aiDmIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.player-requests.status"),
      payload: z.object({ requestId: aiDmIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.player-requests.policy.set"),
      payload: z.object({ requestId: aiDmIdSchema, allowAll: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.player-request.decide"),
      payload: z
        .object({
          requestId: aiDmIdSchema,
          playerRequestId: aiDmIdSchema,
          decision: z.enum(["approve", "refuse"]),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("aiDm.prompt.submit"), payload: promptSubmitSchema }).strict(),
  z
    .object({
      type: z.literal("aiDm.event.submit"),
      payload: z
        .object({
          requestId: aiDmIdSchema,
          eventType: z.enum([
            "combat.turn.changed",
            "door.state.changed",
            "region.transition",
            "item.used",
            "roll.resolved",
            "scene.changed",
          ]),
          sourceCorrelationId: z.string().min(1).max(512),
          presentation: z.enum([
            "silent",
            "collapsed",
            "normal",
            "interrupting",
            "approval-required",
          ]),
          contextHints: contextHintsSchema,
          payload: aiDmJsonValueSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.run.cancel"),
      payload: z.object({ requestId: aiDmIdSchema, runId: aiDmIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.run.retry"),
      payload: z.object({ requestId: aiDmIdSchema, runId: aiDmIdSchema }).strict(),
    })
    .strict(),
  z.object({ type: z.literal("aiDm.approval.decide"), payload: approvalRequestSchema }).strict(),
  z
    .object({
      type: z.literal("aiDm.choice.submit"),
      payload: z
        .object({ requestId: aiDmIdSchema, messageId: aiDmIdSchema, choiceId: aiDmIdSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.history.fetch"),
      payload: z
        .object({
          requestId: aiDmIdSchema,
          threadId: aiDmIdSchema.optional(),
          afterSequence: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
]);

const moduleVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z.+-]+$/);
const sessionCredentialSchema = z.string().min(32).max(512);
const browserSessionIdSchema = z
  .string()
  .min(16)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const assertionSchema = z
  .string()
  .min(64)
  .max(8_192)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export const aiDmTransportClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("aiDm.connect"),
      payload: z
        .object({
          protocolVersion: z.literal(AI_DM_PROTOCOL_VERSION),
          clientId: aiDmIdSchema,
          browserSessionId: browserSessionIdSchema,
          sessionCredential: sessionCredentialSchema,
          moduleVersion: moduleVersionSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.auth.identify"),
      payload: z
        .object({
          protocolVersion: z.literal(AI_DM_PROTOCOL_VERSION),
          clientId: aiDmIdSchema,
          browserSessionId: browserSessionIdSchema,
          worldId: aiDmIdSchema,
          moduleVersion: moduleVersionSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.auth.assertion"),
      payload: z
        .object({
          protocolVersion: z.literal(AI_DM_PROTOCOL_VERSION),
          clientId: aiDmIdSchema,
          browserSessionId: browserSessionIdSchema,
          assertion: assertionSchema,
          moduleVersion: moduleVersionSchema,
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("aiDm.command"), payload: aiDmClientMessageSchema }).strict(),
]);

const accessScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public") }).strict(),
  z.object({ kind: z.literal("gm") }).strict(),
  z.object({ kind: z.literal("users"), userIds: z.array(aiDmIdSchema).max(64) }).strict(),
]);

const effectiveAudienceSchema = z
  .object({
    scope: accessScopeSchema,
    transcript: z.boolean(),
    mirrorToFoundryChat: z.boolean(),
  })
  .strict();

const messageContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plain-text"), text: z.string().max(40_000) }).strict(),
  z
    .object({
      kind: z.literal("structured-card"),
      cardType: z.string().min(1).max(96),
      data: aiDmJsonValueSchema,
    })
    .strict(),
]);

const aiDmMessageSchema = z
  .object({
    messageId: aiDmIdSchema,
    threadId: aiDmIdSchema,
    threadSequence: z.number().int().positive(),
    runId: aiDmIdSchema.nullable(),
    eventId: aiDmIdSchema,
    kind: z.enum([
      "prompt",
      "progress",
      "narration",
      "clarification",
      "roll",
      "choice",
      "approval",
      "diagnostic",
      "error",
    ]),
    deliveryClass: z.enum(["public", "private", "gm", "operational"]),
    effectiveAudience: effectiveAudienceSchema,
    createdAt: aiDmIsoTimestampSchema,
    content: messageContentSchema,
  })
  .strict();

const runStatusSchema = z.enum([
  "queued",
  "projecting",
  "reading-context",
  "searching-tools",
  "resolving",
  "waiting-for-player",
  "waiting-for-gm",
  "committing",
  "delivering",
  "complete",
  "failed",
  "cancelled",
]);

const contextReceiptSchema = z
  .object({
    receiptId: aiDmIdSchema,
    runId: aiDmIdSchema,
    contextGraphRevision: z.string().min(1).max(256),
    entries: z
      .array(
        z
          .object({
            nodeId: aiDmIdSchema,
            revision: z.string().min(1).max(256),
            operation: z.enum(["root", "read", "expand", "search", "changes", "source"]),
            visibilityApplied: z.enum(["public", "player", "gm", "secret"]),
          })
          .strict(),
      )
      .max(256),
    readsUsed: z.number().int().nonnegative(),
    nodesUsed: z.number().int().nonnegative(),
    charactersUsed: z.number().int().nonnegative(),
    estimatedTokensUsed: z.number().int().nonnegative(),
    maximumDepthUsed: z.number().int().nonnegative(),
    budgetExhausted: z.boolean(),
    completedAt: aiDmIsoTimestampSchema,
  })
  .strict();

const dependencySchema = z
  .object({ nodeId: aiDmIdSchema, revision: z.string().min(1).max(256) })
  .strict();
const continuationCapsuleSchema = z
  .object({
    capsuleId: aiDmIdSchema,
    threadId: aiDmIdSchema,
    worldId: aiDmIdSchema,
    principalUserId: aiDmIdSchema,
    disclosureScope: accessScopeSchema,
    priorRunId: aiDmIdSchema,
    priorEventId: aiDmIdSchema,
    createdAt: aiDmIsoTimestampSchema,
    expiresAt: aiDmIsoTimestampSchema,
    visibility: z.enum(["public", "player", "gm", "secret"]),
    summary: z.string().max(4_096),
    unresolvedReferences: z.array(z.string().max(512)).max(32),
    sourceNodeRevisions: z.array(dependencySchema).max(32),
    checksum: z.string().min(1).max(256),
    signature: z.string().min(1).max(512),
  })
  .strict();

export const aiDmServerPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("aiDm.message.created"), payload: aiDmMessageSchema }).strict(),
  z
    .object({
      type: z.literal("aiDm.run.acknowledged"),
      payload: z
        .object({
          requestId: aiDmIdSchema,
          eventId: aiDmIdSchema,
          runId: aiDmIdSchema,
          threadId: aiDmIdSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.run.status"),
      payload: z
        .object({
          runId: aiDmIdSchema,
          status: runStatusSchema,
          occurredAt: aiDmIsoTimestampSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.output.delta"),
      payload: z
        .object({
          runId: aiDmIdSchema,
          messageId: aiDmIdSchema,
          deltaSequence: z.number().int().positive(),
          offset: z.number().int().nonnegative(),
          messageRevision: z.number().int().positive(),
          delta: z.string().max(40_000),
          final: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.approval.required"),
      payload: z
        .object({
          proposalId: aiDmIdSchema,
          proposalRevision: z.string().min(16).max(256),
          summary: z.string().min(1).max(2_000),
          expiresAt: aiDmIsoTimestampSchema,
          operationSummaries: z.array(z.string().min(1).max(1_000)).max(12),
          approvalAuthority: accessScopeSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.run.completed"),
      payload: z
        .object({
          runId: aiDmIdSchema,
          diagnostics: z
            .object({
              receipt: contextReceiptSchema,
              capsule: continuationCapsuleSchema,
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.run.failed"),
      payload: z
        .object({
          runId: aiDmIdSchema,
          code: z.string().min(1).max(160),
          message: z.string().min(1).max(2_000),
          retryable: z.boolean(),
          diagnostics: z
            .object({
              httpStatus: z.number().int().min(100).max(599).optional(),
              providerCode: z.string().min(1).max(160).optional(),
              providerType: z.string().min(1).max(160).optional(),
              providerParam: z.string().min(1).max(160).optional(),
              requestId: z.string().min(1).max(256).optional(),
              terminalEventType: z.string().min(1).max(160).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.history.result"),
      payload: z
        .object({
          requestId: aiDmIdSchema,
          threadId: aiDmIdSchema,
          messages: z.array(aiDmMessageSchema).max(200),
          runs: z
            .array(
              z
                .object({
                  runId: aiDmIdSchema,
                  status: runStatusSchema,
                  failureCode: z.string().min(1).max(160).nullable(),
                })
                .strict(),
            )
            .max(200)
            .optional(),
          hasMore: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);

export const aiDmServerDeliveryEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(AI_DM_PROTOCOL_VERSION),
    deliveryId: aiDmIdSchema,
    recipientUserId: aiDmIdSchema,
    recipientSequence: z.number().int().positive(),
    worldId: aiDmIdSchema,
    threadId: aiDmIdSchema.nullable(),
    runId: aiDmIdSchema.nullable(),
    occurredAt: aiDmIsoTimestampSchema,
    message: aiDmServerPayloadSchema,
  })
  .strict();

export const aiDmTransportServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("aiDm.connected"),
      payload: z
        .object({
          clientId: aiDmIdSchema,
          userId: aiDmIdSchema,
          worldId: aiDmIdSchema,
          lane: z.enum(["gm", "player", "tv"]),
          sessionExpiresAt: aiDmIsoTimestampSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.auth.challenge"),
      payload: z
        .object({
          challengeId: aiDmIdSchema,
          challenge: z
            .string()
            .length(43)
            .regex(/^[A-Za-z0-9_-]+$/),
          connectionId: aiDmIdSchema,
          expiresAt: aiDmIsoTimestampSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.auth.accepted"),
      payload: z
        .object({
          clientId: aiDmIdSchema,
          sessionCredential: sessionCredentialSchema,
          expiresAt: aiDmIsoTimestampSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.connection.refused"),
      payload: z
        .object({
          code: z.string().min(1).max(160),
          message: z.string().min(1).max(2_000),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ type: z.literal("aiDm.delivery"), payload: aiDmServerDeliveryEnvelopeSchema })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.chatgpt.signin.started"),
      payload: z.object({ requestId: aiDmIdSchema, authorizationUrl: z.string().url() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.chatgpt.status"),
      payload: z
        .object({
          requestId: aiDmIdSchema,
          state: z.enum(["signed-out", "connected"]),
          identityConnected: z.boolean(),
          planUsageAuthorized: z.boolean(),
          modelDiscoveryState: z.enum(["not-authorized", "unavailable", "empty", "available"]),
          remoteRevocationConfirmed: z.boolean().optional(),
          gmUserId: aiDmIdSchema.optional(),
          email: z.string().email().optional(),
          expiresAt: aiDmIsoTimestampSchema.optional(),
          availableModels: z
            .array(
              z
                .object({
                  slug: z
                    .string()
                    .min(1)
                    .max(256)
                    .regex(/^[A-Za-z0-9._:-]+$/),
                  displayName: z.string().min(1).max(256),
                })
                .strict(),
            )
            .max(1_000),
          selectedModel: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z0-9._:-]+$/)
            .nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aiDm.player-requests.state"),
      payload: z
        .object({
          requestId: aiDmIdSchema,
          allowAll: z.boolean(),
          requests: z
            .array(
              z
                .object({
                  playerRequestId: aiDmIdSchema,
                  requesterUserId: aiDmIdSchema,
                  text: z.string().min(1).max(AI_DM_MAX_PROMPT_LENGTH),
                  status: z.enum(["waiting-for-gm", "approved", "refused"]),
                  requestedAt: aiDmIsoTimestampSchema,
                })
                .strict(),
            )
            .max(200),
        })
        .strict(),
    })
    .strict(),
]);
