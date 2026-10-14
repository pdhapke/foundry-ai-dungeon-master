import { z } from "zod";
const id=z.string().min(1);
const point=z.object({x:z.number(),y:z.number(),elevation:z.number().optional()}).strict();
const bridgeLane=z.enum(["gm","player","tv"]);
const movementField = z.enum(["x", "y", "elevation"]);
const transition = z
  .object({
    regionId: id,
    regionName: z.string().optional(),
    category: z.enum(["hazard", "threshold", "exit", "room", "corridor", "other"]),
    stopOnEnter: z.literal(true).optional(),
    kind: z.enum(["enter", "exit"]),
    segmentIndex: z.number().int(),
    t: z.number(),
    point,
  })
  .strict();
export const movementEventOutputSchema = z
  .object({
    eventId: id,
    eventType: z.literal("token_movement"),
    movementFields: z.array(movementField),
    sceneId: id,
    tokenId: id,
    userId: id,
    timestamp: z.number(),
    from: point,
    to: point,
    footprint: z.object({ width: z.number(), height: z.number() }).strict(),
    geometryStatus: z.enum(["complete", "incomplete"]),
    incompleteReasons: z.array(z.string()),
    deltas: z.array(z.object({ dx: z.number(), dy: z.number(), delevation: z.number() }).strict()),
    waypoints: z.array(point),
    segments: z.array(
      z
        .object({
          index: z.number().int(),
          from: point,
          to: point,
          dx: z.number(),
          dy: z.number(),
          delevation: z.number(),
        })
        .strict(),
    ),
    transitions: z.array(transition),
    firstStop: transition.optional(),
    acceptedPoint: point,
    remainingPath: z.array(point),
    pendingMovement: z
      .object({
        status: z.literal("pending"),
        stop: transition,
        acceptedPoint: point,
        remainingPath: z.array(point),
      })
      .strict()
      .optional(),
    provenance: z
      .object({ reporterClientId: id, reporterUserId: id, reporterLane: bridgeLane })
      .strict()
      .optional(),
  })
  .strict();
export const sequencedMovementEventOutputSchema = movementEventOutputSchema.extend({
  sequence: z.number().int().positive(),
});
