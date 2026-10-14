import { z } from "zod";
import { ProtocolError } from "../../../../foundry-local-api/shared/dist/index.js";
import type {AnyEndpointDescriptor} from "./api-contract.js";
let rolloverGeneration:
  ((input: MovementGenerationRolloverInput) => MovementGenerationRolloverResult) | undefined;
let protocolError = (body: ConstructorParameters<typeof ProtocolError>[0]): Error => new ProtocolError(body);
export function configureMovementGenerationRollover(
  value: ((input: MovementGenerationRolloverInput) => MovementGenerationRolloverResult) | undefined,
  errorFactory: ((body: ConstructorParameters<typeof ProtocolError>[0]) => Error) = body => new ProtocolError(body),
) {
  rolloverGeneration = value;
  protocolError = errorFactory;
}
const rolloverInput = z
  .object({
    expectedGeneration: z.string().min(1).max(512),
    expectedMovementSha256: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
    confirmation: z.literal("quarantine-and-rollover"),
  })
  .strict();
const boundedArchive = z
  .object({
    movementFile: z.string().min(1).max(255),
    movementBytes: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
    movementSha256: z.string().regex(/^[a-f0-9]{64}$/),
    deliveryFile: z.string().min(1).max(255),
    deliveryBytes: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
    deliverySha256: z.string().regex(/^[a-f0-9]{64}$/),
    deliveryItemCount: z.number().int().nonnegative().max(20_000),
  })
  .strict();
export const movementGenerationRolloverOutputSchema = z
  .object({
    status: z.literal("completed"),
    replayed: z.boolean(),
    oldGeneration: z.string().min(1).max(512),
    newGeneration: z.string().uuid(),
    quarantine: boundedArchive,
    current: z
      .object({
        movementSha256: z.string().regex(/^[a-f0-9]{64}$/),
        deliverySha256: z.string().regex(/^[a-f0-9]{64}$/),
        cursor: z.string().min(1).max(550),
      })
      .strict(),
    completedAt: z.number().int().nonnegative(),
  })
  .strict();
import {
  MovementGenerationRolloverError,
  type MovementGenerationRolloverInput,
  type MovementGenerationRolloverResult,
} from "./movement-generation-rollover.js";
export const rolloverEndpointDescriptors:AnyEndpointDescriptor[]=[
  {
    name: "foundry_rollover_movement_store_generation",
    description:
      "Destructively closes an explicitly hash-pinned invalid movement generation by preserving exact movement and AI-GM delivery bytes in content-addressed, write-verified quarantine artifacts, then uses crash-resumable per-file atomic replacement to install empty schema-valid stores on a new UUID generation boundary. Requires an exact confirmation and idempotency key; never repairs, rewrites, or deletes historical evidence.",
    method: "post",
    path: "/movement-events/recovery/rollover",
    inputSchema: rolloverInput,
    outputSchema: movementGenerationRolloverOutputSchema,
    handler: (input: MovementGenerationRolloverInput): MovementGenerationRolloverResult => {
      if (!rolloverGeneration)
        throw protocolError({
          code: "INCOMPLETE_RESULT",
          message: "Movement generation rollover is not configured.",
          retryable: true,
        });
      try {
        return rolloverGeneration(input);
      } catch (error) {
        if (!(error instanceof MovementGenerationRolloverError)) throw error;
        const code =
          error.code === "IDEMPOTENCY_CONFLICT"
            ? "IDEMPOTENCY_CONFLICT"
            : error.code === "HASH_MISMATCH"
              ? "HASH_MISMATCH"
              : error.code === "GENERATION_MISMATCH"
                ? "STALE_REVISION"
                : error.code === "INVALID_REQUEST"
                  ? "INVALID_PAYLOAD"
                  : "INCOMPLETE_RESULT";
        throw protocolError({
          code,
          message: error.message,
          retryable: false,
        });
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
];
