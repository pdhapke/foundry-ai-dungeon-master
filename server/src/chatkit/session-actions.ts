import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { validateArguments, type FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { stableJson } from "../context/hash.js";
import { bounded } from "./bounded-call.js";
import type { SessionRequestAuthorization } from "./pause-request.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const target = { sceneId: id, targetId: id };
const lightRadius = z.number().finite().min(0).max(10000)
  .refine(value => value === Number(value.toFixed(2)), "Light radii require 0.01 scene-unit precision");
export const tokenLightSchema = z.object({
  bright: lightRadius.optional(), dim: lightRadius.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).toLowerCase().nullable().optional(),
  alpha: z.number().finite().min(0).max(1).optional(),
}).strict().refine(light => Object.keys(light).length > 0, "Supply at least one light field");
export const sessionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("token.light"), ...target, light: tokenLightSchema }).strict(),
  z
    .object({ kind: z.literal("actor.hp"), ...target, value: z.number().int().min(0).max(100000) })
    .strict(),
  z
    .object({
      kind: z.literal("door.state"),
      ...target,
      value: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("token.position"),
      ...target,
      x: z.number().min(0).max(100000),
      y: z.number().min(0).max(100000),
      mode: z.enum(["walk", "teleport"]).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("combat.next"), ...target }).strict(),
  z
    .object({
      kind: z.literal("combat.initiative"),
      ...target,
      combatantId: id,
      value: z.number().min(-10000).max(10000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat.post"),
      text: z
        .string()
        .min(1)
        .max(4000)
        .refine((text) => !/[<>]/.test(text)),
    })
    .strict(),
  z
    .object({ kind: z.literal("actor.condition"), ...target, conditionId: id, active: z.boolean() })
    .strict(),
  z
    .object({
      kind: z.literal("playlist.sound"),
      targetId: id,
      soundId: id,
      state: z.enum(["playing", "paused", "stopped"]),
    })
    .strict(),
]);
type Action = z.infer<typeof sessionActionSchema>;
const requestSchema = z
  .object({
    actionId: id,
    action: sessionActionSchema,
    expectedState: z.record(z.string(), z.unknown()),
  })
  .strict();
const readSchema = z.object({ action: sessionActionSchema }).strict();
type Scope = { worldId: string; userId: string; threadId: string };
type Entry = {
  scope: Scope;
  actionId: string;
  kind: "session";
  input: AiDmJsonValue;
  status: "dispatching" | "completed" | "stale" | "cancelled" | "uncertain";
  correlationId: string;
  receipt: AiDmJsonValue | null;
};
const object = (value: AiDmJsonValue) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed session result");
  return value;
};
const equal = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
export const SESSION_SEMANTIC_TOOLS: Record<string, { kind: Action["kind"]; purpose: string }> = {
  ai_dm_set_token_light: {
    kind: "token.light",
    purpose: "Set emitted light on one placed scene token; scene-unit radii, preserve omitted fields. Clear with bright=dim=0. Not vision, ambient light or prototype token. Resolve exact scene/token IDs; never guess spell settings.",
  },
  ai_dm_set_actor_hp: {
    kind: "actor.hp",
    purpose: "Set current-scene actor hit points HP within maximum",
  },
  ai_dm_set_door_state: { kind: "door.state", purpose: "Open close lock current-scene door state" },
  ai_dm_move_token: {
    kind: "token.position",
    purpose: "Move current-scene token to bounded x y coordinates",
  },
  ai_dm_advance_combat_turn: {
    kind: "combat.next",
    purpose: "Advance active combat next turn once",
  },
  ai_dm_set_initiative: { kind: "combat.initiative", purpose: "Set active combatant initiative" },
  ai_dm_post_chat: { kind: "chat.post", purpose: "Post bounded plain message to game chat" },
  ai_dm_set_actor_condition: {
    kind: "actor.condition",
    purpose: "Set or remove trusted actor condition status on current scene",
  },
  ai_dm_set_playlist_sound: {
    kind: "playlist.sound",
    purpose: "Play pause stop a named playlist music sound",
  },
};
const fieldId = { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" };
const properties: Record<Action["kind"], Record<string, unknown>> = {
  "token.light": { sceneId: fieldId, targetId: fieldId, light: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: {
      bright: { type: "number", minimum: 0, maximum: 10000, description: "0.01 scene-unit precision" },
      dim: { type: "number", minimum: 0, maximum: 10000, description: "0.01 scene-unit precision" },
      color: { anyOf: [{ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, { type: "null" }] },
      alpha: { type: "number", minimum: 0, maximum: 1 },
    },
  } },
  "actor.hp": {
    sceneId: fieldId,
    targetId: fieldId,
    value: { type: "integer", minimum: 0, maximum: 100000 },
  },
  "door.state": { sceneId: fieldId, targetId: fieldId, value: { enum: [0, 1, 2] } },
  "token.position": {
    sceneId: fieldId,
    targetId: fieldId,
    x: { type: "number", minimum: 0, maximum: 100000 },
    y: { type: "number", minimum: 0, maximum: 100000 },
    mode: { type: "string", enum: ["walk", "teleport"] },
  },
  "combat.next": { sceneId: fieldId, targetId: fieldId },
  "combat.initiative": {
    sceneId: fieldId,
    targetId: fieldId,
    combatantId: fieldId,
    value: { type: "number", minimum: -10000, maximum: 10000 },
  },
  "chat.post": { text: { type: "string", minLength: 1, maxLength: 4000, pattern: "^[^<>]*$" } },
  "actor.condition": {
    sceneId: fieldId,
    targetId: fieldId,
    conditionId: fieldId,
    active: { type: "boolean" },
  },
  "playlist.sound": {
    targetId: fieldId,
    soundId: fieldId,
    state: { enum: ["playing", "paused", "stopped"] },
  },
};
const actionJsonSchema = (kind: Action["kind"]) => ({
  type: "object",
  additionalProperties: false,
  properties: { kind: { const: kind }, ...properties[kind] },
  required: ["kind", ...Object.keys(properties[kind])],
});
export function sessionSemanticSchema(toolId: string): AiDmJsonValue {
  const descriptor = SESSION_SEMANTIC_TOOLS[toolId];
  const action = descriptor
    ? actionJsonSchema(descriptor.kind)
    : { anyOf: Object.keys(properties).map((kind) => actionJsonSchema(kind as Action["kind"])) };
  return {
    type: "object",
    additionalProperties: false,
    properties: descriptor
      ? { actionId: fieldId, action, expectedState: { type: "object" } }
      : { action },
    required: descriptor ? ["actionId", "action", "expectedState"] : ["action"],
  };
}
/** Scoped, bounded routine setters. Durable claim precedes possible effects; uncertain state never redispatches. */
export class ChatKitSessionActions {
  constructor(
    private readonly client: FoundryLocalApiMcpClient,
    private readonly db: DatabaseSync,
    private readonly authorize: (
      identity: AiDmAuthenticatedIdentity,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly timeoutMs = 10000,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS chatkit_session_actions(scope_key TEXT PRIMARY KEY,entry_json TEXT NOT NULL)",
    );
  }
  private key(scope: Scope, actionId: string) {
    return JSON.stringify([scope.worldId, scope.userId, scope.threadId, actionId]);
  }
  recent(scope: Scope): AiDmJsonValue[] {
    const prefix = JSON.stringify([scope.worldId, scope.userId, scope.threadId]).slice(0, -1) + ",";
    return this.db
      .prepare(
        "SELECT entry_json FROM chatkit_session_actions WHERE scope_key>=? AND scope_key<? ORDER BY rowid DESC LIMIT 12",
      )
      .all(prefix, prefix + "\uffff")
      .map((row) => JSON.parse(String(row["entry_json"])) as Entry)
      .filter((entry) => equal(entry.scope, scope))
      .slice(0, 12)
      .map((entry) => ({
        ...entry,
        status: entry.status === "dispatching" ? "uncertain" : entry.status,
        requiresConfirmation: false,
      }));
  }
  async request(
    identity: AiDmAuthenticatedIdentity,
    scope: Scope,
    operation: string,
    args: unknown,
    authorization: SessionRequestAuthorization | undefined,
    outerSignal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    if (!identity.isGm || scope.worldId !== identity.worldId || scope.userId !== identity.userId)
      throw new Error("Current GM world scope required");
    id.parse(scope.threadId);
    if (Buffer.byteLength(JSON.stringify(args)) > 10000)
      throw new Error("Session input budget exceeded");
    const isRead = operation === "native_session_read";
    if (!isRead && !["native_session_apply", "native_session_authorize"].includes(operation))
      throw new Error("Session operation denied");
    const parsed = isRead ? readSchema.parse(args) : requestSchema.parse(args);
    const intent = authorization?.session;
    if (!isRead && (intent ? intent.kind !== parsed.action.kind || !authorization?.sessionKinds?.includes(parsed.action.kind) : !authorization?.worldControl?.manualRequest))
      throw new Error("Explicit current GM action kind required");
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    const check = async () => {
      signal.throwIfAborted();
      await bounded(this.authorize(identity, signal), signal);
      signal.throwIfAborted();
    };
    await check();
    const definitions = await bounded(this.client.listTools(), signal);
    const call = async (name: string, input: AiDmJsonValue) => {
      await check();
      const schema = definitions.find((tool) => tool.name === name)?.inputSchema;
      if (!schema || validateArguments(schema, input).length)
        throw new Error("Session schema unavailable");
      return bounded(
        this.client.callTool(
          { name, arguments: input, idempotencyKey: null },
          { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
        ),
        signal,
      );
    };
    const validateIntent = async () => {
      if (isRead) return;
      if (!intent && authorization?.worldControl?.manualRequest) return;
      const a = parsed.action;
      for (const field of ["value", "x", "y", "text", "conditionId", "active", "state"] as const)
        if (field in a && !equal((a as Record<string, unknown>)[field], intent?.[field]))
          throw new Error("Action value differs from direct GM request");
      if (a.kind === "combat.next" || a.kind === "chat.post") return;
      const normalized = (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "";
      const label = normalized(
        a.kind === "playlist.sound" ? intent?.soundLabel : intent?.targetLabel,
      );
      if (!label) throw new Error("Exact target request required");
      const selectedId =
        a.kind === "combat.initiative"
          ? a.combatantId
          : a.kind === "playlist.sound"
            ? a.soundId
            : a.targetId;
      // Explicit document identifiers still pass the underlying active-world/scene checks.
      if (label === normalized(selectedId)) return;
      let candidates: Record<string, AiDmJsonValue>[] = [];
      if (a.kind === "playlist.sound") {
        const playlists = await call("foundry_list_playlists", {});
        if (!Array.isArray(playlists) || playlists.length > 32)
          throw new Error("Playlist selection requires explicit ID");
        for (const playlist of playlists.map(object)) {
          const full = object(
            await call("foundry_get_playlist", { id: playlist["_id"] ?? playlist["id"]! }),
          );
          if (Array.isArray(full["sounds"]))
            for (const sound of full["sounds"].map(object))
              if (normalized(sound["name"]) === label)
                candidates.push({ ...sound, playlistId: full["_id"] ?? full["id"]! });
        }
        if (candidates.length !== 1 || candidates[0]!["playlistId"] !== a.targetId)
          throw new Error("Ambiguous or mismatched playlist sound");
      } else if (a.kind === "combat.initiative") {
        const combat = object(await call("foundry_get_combat", { id: a.targetId }));
        candidates = Array.isArray(combat["combatants"])
          ? combat["combatants"]
              .map(object)
              .filter((candidate) => normalized(candidate["name"]) === label)
          : [];
      } else {
        const scene = object(await call("foundry_get_scene", { id: a.sceneId }));
        const list = a.kind === "door.state" ? scene["walls"] : scene["tokens"];
        if (!Array.isArray(list) || list.length > 64)
          throw new Error("Target selection requires explicit ID");
        const docs = list.map(object);
        if (a.kind === "actor.hp" || a.kind === "actor.condition") {
          const actorIds = [
            ...new Set(
              docs
                .map((doc) => doc["actorId"])
                .filter((value): value is string => typeof value === "string"),
            ),
          ];
          if (actorIds.length > 16) throw new Error("Actor selection requires explicit ID");
          for (const actorId of actorIds) {
            const actor = object(await call("foundry_get_actor", { id: actorId }));
            if (normalized(actor["name"]) === label) candidates.push(actor);
          }
        } else
          candidates = docs.filter((doc) =>
            a.kind === "door.state" && label === "door"
              ? typeof doc["door"] === "number" && doc["door"] > 0
              : normalized(doc["name"]) === label,
          );
      }
      if (candidates.length !== 1 || (candidates[0]!["_id"] ?? candidates[0]!["id"]) !== selectedId)
        throw new Error("Ambiguous target; clarify a unique name or ID");
    };
    const base = { worldId: scope.worldId, requestingUserId: scope.userId, action: parsed.action as AiDmJsonValue };
    const read = async () => {
      const result = object(await call("foundry_get_session_action_state", base));
      if (result["worldId"] !== scope.worldId || !equal(result["action"], parsed.action))
        throw new Error("Session read scope mismatch");
      const state = object(result["state"]!);
      if (Buffer.byteLength(JSON.stringify(state)) > 4000)
        throw new Error("Session state budget exceeded");
      return state;
    };
    if (isRead) {
      const state = await read();
      await check();
      return { ...base, state, trust: "untrusted-source-data" };
    }
    await validateIntent();
    if (operation === "native_session_authorize") {
      await read();
      await check();
      return { authorized: true };
    }
    const input = requestSchema.parse(parsed);
    const key = this.key(scope, input.actionId);
    const load = () => {
      const row = this.db
        .prepare("SELECT entry_json FROM chatkit_session_actions WHERE scope_key=?")
        .get(key);
      return row ? (JSON.parse(String(row["entry_json"])) as Entry) : undefined;
    };
    const view = (entry: Entry): AiDmJsonValue => ({
      ...entry,
      status: entry.status === "dispatching" ? "uncertain" : entry.status,
      requiresConfirmation: false,
    });
    const previous = load();
    if (previous) {
      if (!equal(previous.input, input)) throw new Error("Session action ID conflict");
      return view(previous);
    }
    const before = await read();
    const entry: Entry = {
      scope,
      actionId: input.actionId,
      kind: "session",
      input: input as AiDmJsonValue,
      status: equal(before, input.expectedState) ? "dispatching" : "stale",
      correlationId: `aidm-${randomUUID()}`,
      receipt: null,
    };
    await check();
    const claim = this.db
      .prepare("INSERT INTO chatkit_session_actions VALUES (?,?) ON CONFLICT(scope_key) DO NOTHING")
      .run(key, JSON.stringify(entry));
    if (!claim.changes) {
      const winner = load()!;
      if (!equal(winner.input, input)) throw new Error("Session action ID conflict");
      return view(winner);
    }
    if (entry.status === "stale") return view(entry);
    const original = JSON.stringify(entry);
    let dispatched = false;
    try {
      if (!equal(await read(), before)) throw new Error("Session state changed before dispatch");
      if (!equal(await bounded(this.client.listTools(), signal), definitions))
        throw new Error("Session schema drift");
      const payload = {
        ...base,
        expectedState: input.expectedState,
        correlationId: entry.correlationId,
        idempotencyKey: entry.correlationId,
      } as AiDmJsonValue;
      const applySchema = definitions.find(
        (tool) => tool.name === "foundry_apply_session_action",
      )?.inputSchema;
      if (!applySchema || validateArguments(applySchema, payload).length)
        throw new Error("Session apply schema unavailable");
      await check();
      dispatched = true;
      const result = object(await call("foundry_apply_session_action", payload));
      if (
        result["verified"] !== true ||
        result["worldId"] !== scope.worldId ||
        result["correlationId"] !== entry.correlationId ||
        result["idempotencyKey"] !== entry.correlationId ||
        !equal(result["action"], input.action)
      )
        throw new Error("Session execution receipt mismatch");
      const after = object(result["state"]!);
      if (input.action.kind === "chat.post") {
        const messages = await call("foundry_list_chat_messages", { limit: 8 });
        const text = input.action.text;
        if (
          !Array.isArray(messages) ||
          !messages
            .map(object)
            .some(
              (message) =>
                (message["_id"] ?? message["id"]) === after["messageId"] &&
                message["content"] === text &&
                message["user"] === scope.userId,
            )
        )
          throw new Error("Chat independent read-back uncertain");
      } else if (!equal(await read(), after))
        throw new Error("Session independent read-back mismatch");
      const a = input.action;
      const matches =
        a.kind === "token.light"
          ? !!after["light"] && typeof after["light"] === "object" && !Array.isArray(after["light"]) &&
            Object.entries(a.light).every(([key, value]) => (after["light"] as Record<string, unknown>)[key] === value)
          : a.kind === "actor.hp"
          ? after["value"] === a.value
          : a.kind === "door.state"
            ? after["ds"] === a.value
            : a.kind === "token.position"
              ? after["x"] === a.x && after["y"] === a.y
              : a.kind === "combat.initiative"
                ? after["initiative"] === a.value
                : a.kind === "combat.next"
                  ? typeof before["round"] === "number" &&
                    Number.isInteger(before["round"]) &&
                    before["round"] >= 1 &&
                    typeof before["turn"] === "number" &&
                    Number.isInteger(before["turn"]) &&
                    before["turn"] >= 0 &&
                    typeof before["turnCount"] === "number" &&
                    Number.isInteger(before["turnCount"]) &&
                    before["turnCount"] > 0 &&
                    before["turn"] < before["turnCount"] &&
                    ((after["round"] === before["round"] &&
                      after["turn"] === before["turn"] + 1 &&
                      before["turn"] < before["turnCount"] - 1) ||
                      (typeof before["turnCount"] === "number" &&
                        Number.isInteger(before["turnCount"]) &&
                        before["turnCount"] > 0 &&
                        before["turn"] === before["turnCount"] - 1 &&
                        after["round"] === before["round"] + 1 &&
                        after["turn"] === 0))
                  : a.kind === "actor.condition"
                    ? after["active"] === a.active
                    : a.kind === "playlist.sound"
                      ? a.state === "playing"
                        ? after["playing"] === true
                        : after["playing"] === false &&
                          (a.state === "stopped"
                            ? after["pausedTime"] === null
                            : typeof after["pausedTime"] === "number")
                      : after["content"] === a.text;
      if (!matches) throw new Error("Session desired result mismatch");
      await check();
      entry.status = "completed";
      entry.receipt = {
        ...result,
        before,
        verifiedBy:
          input.action.kind === "chat.post"
            ? "foundry_list_chat_messages"
            : "foundry_get_session_action_state",
      };
    } catch {
      entry.status = dispatched ? "uncertain" : signal.aborted ? "cancelled" : "stale";
    }
    this.db
      .prepare("UPDATE chatkit_session_actions SET entry_json=? WHERE scope_key=? AND entry_json=?")
      .run(JSON.stringify(entry), key, original);
    return view(load()!);
  }
}
