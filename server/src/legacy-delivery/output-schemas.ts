import { z } from "zod";
import { sequencedMovementEventOutputSchema } from "./movement-output-schema.js";
const id=z.string().min(1);
const point=z.object({x:z.number(),y:z.number(),elevation:z.number().optional()}).strict();
const deliveryState = z.enum(["queued", "in_flight", "retry_wait", "acknowledged", "dead_letter"]);
export const aiGmDeliveryItemOutputSchema = z
  .object({
    id,
    consumerId: id,
    eventId: id,
    eventSequence: z.number().int().positive(),
    eventCursor: z.string(),
    event: sequencedMovementEventOutputSchema,
    state: deliveryState,
    adjudication: z
      .object({
        status: z.literal("pending_adjudication"),
        firstStop: z
          .object({ reason: z.string(), acceptedPoint: point, remainingPath: z.array(point) })
          .strict()
          .optional(),
        automaticConsequencesApplied: z.literal(false),
      })
      .strict(),
    attemptHistory: z.array(
      z
        .object({
          attempt: z.number().int().positive(),
          startedAt: z.number(),
          finishedAt: z.number().optional(),
          outcome: z
            .enum(["acknowledged", "retry_scheduled", "dead_letter", "interrupted"])
            .optional(),
          errorCode: z.string().optional(),
          message: z.string().optional(),
        })
        .strict(),
    ),
    createdAt: z.number(),
    updatedAt: z.number(),
    nextAttemptAt: z.number().optional(),
    acknowledgementId: z.string().optional(),
    acknowledgedAt: z.number().optional(),
    deadLetteredAt: z.number().optional(),
    lastFailure: z
      .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export const aiGmDeliveryListOutputSchema = z
  .object({
    consumerId: id,
    hostCapability: z.enum(["invoke", "wake", "unavailable"]),
    hostLimitation: z.string().optional(),
    reconciliationWatermark: z
      .object({
        generation: z.string(),
        sequence: z.number().int().nonnegative(),
        cursor: z.string(),
        initializedAt: z.number(),
        updatedAt: z.number(),
      })
      .strict()
      .nullable(),
    items: z.array(aiGmDeliveryItemOutputSchema),
  })
  .strict();
