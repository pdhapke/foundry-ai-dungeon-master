import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { stableJson } from "../context/hash.js";
import { sessionActionSchema } from "./session-actions.js";
import { bounded } from "./bounded-call.js";
import type { SessionRequestAuthorization } from "./pause-request.js";
import { latencyEvent } from "../latency-trace.js";

export const CORE_PROTOCOL = "core-actions-v1";
export const coreActionSchema = z.union([
  sessionActionSchema.refine((a) => !["chat.post", "playlist.sound"].includes(a.kind), "Excluded core effect"),
  z.object({ kind: z.literal("dice.roll"), formula: z.string().regex(/^([1-9]|[1-9][0-9])d(4|6|8|10|12|20|100)([+-][0-9]{1,3})?$/) }).strict(),
  z.object({ kind: z.literal("system.roll"), sceneId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    rollType: z.enum(["ability", "save", "skill"]), key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }).strict(),
]);
type Scope = { worldId: string; userId: string; threadId: string };
const inputSchema = z.object({ actionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), action: coreActionSchema }).strict();

/** Fixed reviewed protocol; execution never uses model discovery or cached authority. */
export class ChatKitCoreActions {
  constructor(private readonly client: FoundryLocalApiMcpClient, private readonly db: DatabaseSync,
    private readonly authorize: (identity: AiDmAuthenticatedIdentity, signal: AbortSignal) => Promise<void>,
    private readonly timeoutMs = 10000) {
    db.exec("CREATE TABLE IF NOT EXISTS chatkit_core_actions(scope_key TEXT PRIMARY KEY,entry_json TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS chatkit_core_batches(scope_key TEXT PRIMARY KEY,input_json TEXT NOT NULL)");
  }
  recent(scope: Scope): AiDmJsonValue[] {
    return this.db.prepare("SELECT entry_json FROM chatkit_core_actions ORDER BY rowid DESC LIMIT 100").all()
      .map((row) => JSON.parse(String(row["entry_json"])) as Record<string, AiDmJsonValue>)
      .filter((entry) => stableJson(entry["scope"]) === stableJson(scope)).slice(0, 12)
      .map((entry) => ({ ...entry, kind: "session", input: { action: entry["action"]! },
        status: (entry["result"] as Record<string, AiDmJsonValue> | undefined)?.["outcome"] ?? "uncertain", receipt: entry["result"] ?? null }));
  }
  async moveBatch(identity: AiDmAuthenticatedIdentity, scope: Scope, args: unknown,
    authority: SessionRequestAuthorization | undefined, signal: AbortSignal): Promise<AiDmJsonValue> {
    const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
    const input = z.object({ actionId: id, sceneId: id, moves: z.array(z.object({ tokenId: id, x: z.number().min(0).max(100000), y: z.number().min(0).max(100000) }).strict()).min(1).max(8) }).strict().parse(args);
    if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId || !authority?.worldControl?.manualRequest || !/^[a-f0-9]{64}$/.test(authority.worldControl.requestDigest)) throw new Error("Current authenticated manual GM world request required");
    if (new Set(input.moves.map((move) => move.tokenId)).size !== input.moves.length) throw new Error("Duplicate batch target; use one desired position per token");
    signal.throwIfAborted(); await bounded(this.authorize(identity, signal), signal); signal.throwIfAborted();
    const batchKey = stableJson([scope.worldId, scope.userId, scope.threadId, input.actionId]);
    const fingerprint = stableJson(input);
    this.db.prepare("INSERT INTO chatkit_core_batches VALUES (?,?) ON CONFLICT(scope_key) DO NOTHING").run(batchKey, fingerprint);
    if (this.db.prepare("SELECT input_json FROM chatkit_core_batches WHERE scope_key=?").get(batchKey)?.["input_json"] !== fingerprint) throw new Error("Movement batch action ID conflict");
    const results: AiDmJsonValue[] = [];
    // Sequential, non-atomic: confirmed targets persist, uncertainty fences the rest.
    for (const [index, move] of input.moves.entries()) {
      if (signal.aborted) break;
      let result: AiDmJsonValue;
      try { result = await this.request(identity, scope, { actionId: createHash("sha256").update(stableJson([input.actionId, input, index])).digest("hex"),
        action: { kind: "token.position", sceneId: input.sceneId, targetId: move.tokenId, x: move.x, y: move.y } }, authority, signal); }
      catch { result = { outcome: signal.aborted ? "cancelled" : "failure", message: "Target not dispatched; current authorization or input unavailable." }; }
      results.push({ tokenId: move.tokenId, result });
      if (!result || typeof result !== "object" || Array.isArray(result) || result["outcome"] !== "confirmed") break;
    }
    return { atomic: false, cancelled: signal.aborted, requested: input.moves.length, completedOrAttempted: results.length,
      unattempted: input.moves.slice(results.length).map((move) => move.tokenId), results };
  }
  async read(identity: AiDmAuthenticatedIdentity, scope: Scope, args: unknown, outerSignal: AbortSignal): Promise<AiDmJsonValue> {
    z.object({}).strict().parse(args);
    if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId) throw new Error("Current GM world required");
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    signal.throwIfAborted(); await bounded(this.authorize(identity, signal), signal); signal.throwIfAborted();
    const receipt = await bounded(this.client.callTool({ name: "foundry_core_state", arguments: {
      worldId: scope.worldId, userId: scope.userId, schemaVersion: CORE_PROTOCOL,
    }, idempotencyKey: null }, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }), signal);
    await bounded(this.authorize(identity, signal), signal); signal.throwIfAborted();
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt["worldId"] !== scope.worldId || receipt["schemaVersion"] !== CORE_PROTOCOL ||
      Buffer.byteLength(JSON.stringify(receipt)) > 24000) throw new Error("Invalid bounded core state");
    return { ...receipt, trust: "untrusted-source-data" };
  }
  async readTokenLight(identity: AiDmAuthenticatedIdentity, scope: Scope, args: unknown, outerSignal: AbortSignal): Promise<AiDmJsonValue> {
    const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
    const input = z.object({ sceneId: id, tokenId: id }).strict().parse(args);
    if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId)
      throw new Error("Current GM world required");
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    signal.throwIfAborted(); await bounded(this.authorize(identity, signal), signal); signal.throwIfAborted();
    let receipt: AiDmJsonValue;
    try {
      receipt = await bounded(this.client.callTool({ name: "foundry_get_token_light", arguments: {
        worldId: scope.worldId, userId: scope.userId, ...input,
      }, idempotencyKey: null }, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }), signal);
    } catch {
      throw new Error("Token-emitted light read unavailable; verify loaded MCP token-light capability and current GM connection. No light change was requested.");
    }
    await bounded(this.authorize(identity, signal), signal); signal.throwIfAborted();
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt["worldId"] !== scope.worldId ||
      receipt["sceneId"] !== input.sceneId || receipt["tokenId"] !== input.tokenId || receipt["scope"] !== "placed-token" ||
      typeof receipt["units"] !== "string" || !receipt["light"] || typeof receipt["light"] !== "object" || Array.isArray(receipt["light"]) ||
      Buffer.byteLength(JSON.stringify(receipt)) > 10000) throw new Error("Invalid bounded placed-token light state");
    return { ...receipt, trust: "untrusted-source-data" };
  }
  async request(identity: AiDmAuthenticatedIdentity, scope: Scope, args: unknown,
    authority: SessionRequestAuthorization | undefined, outerSignal: AbortSignal): Promise<AiDmJsonValue> {
    const input = inputSchema.parse(args);
    if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId || !scope.threadId ||
      !authority?.worldControl?.manualRequest || !/^[a-f0-9]{64}$/.test(authority.worldControl.requestDigest))
      throw new Error("Current authenticated manual GM world request required");
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    const check = async () => { signal.throwIfAborted(); await bounded(this.authorize(identity, signal), signal); signal.throwIfAborted(); };
    await check();
    const key = stableJson([scope.worldId, scope.userId, scope.threadId, input.actionId]);
    const load = () => {
      const row = this.db.prepare("SELECT entry_json FROM chatkit_core_actions WHERE scope_key=?").get(key);
      return row ? JSON.parse(String(row["entry_json"])) as Record<string, AiDmJsonValue> : undefined;
    };
    const prior = load();
    if (prior) {
      if (stableJson(prior["action"]) !== stableJson(input.action)) throw new Error("Core action ID conflict");
      return prior["result"] ?? { outcome: "uncertain", worldId: scope.worldId, correlationId: prior["correlationId"]!, action: input.action as AiDmJsonValue, state: null, mutated: false };
    }
    const correlationId = `aidm-${randomUUID()}`;
    const pending = { scope, actionId: input.actionId, action: input.action as AiDmJsonValue, correlationId, schemaVersion: CORE_PROTOCOL };
    const claim = this.db.prepare("INSERT INTO chatkit_core_actions VALUES (?,?) ON CONFLICT(scope_key) DO NOTHING").run(key, JSON.stringify(pending));
    if (!claim.changes) {
      const winner = load()!;
      if (stableJson(winner["action"]) !== stableJson(input.action)) throw new Error("Core action ID conflict");
      return winner["result"] ?? { outcome: "uncertain", worldId: scope.worldId, correlationId: winner["correlationId"]!, action: input.action as AiDmJsonValue, state: null, mutated: false };
    }
    let result: AiDmJsonValue;
    const started = performance.now();
    try {
      await check();
      const receipt = await bounded(this.client.callTool({ name: "foundry_core_action_confirmed", arguments: {
        schemaVersion: CORE_PROTOCOL, worldId: scope.worldId, userId: scope.userId,
        requestId: createHash("sha256").update(key).digest("hex"), correlationId, origin: "ai-dm", action: input.action as AiDmJsonValue,
      }, idempotencyKey: null }, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }), signal);
      await check();
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt["schemaVersion"] !== CORE_PROTOCOL ||
        receipt["worldId"] !== scope.worldId || receipt["correlationId"] !== correlationId ||
        stableJson(receipt["action"]) !== stableJson(input.action) ||
        !["confirmed", "uncertain", "failure"].includes(String(receipt["outcome"])) || typeof receipt["mutated"] !== "boolean" ||
        (receipt["outcome"] === "confirmed" && (!receipt["state"] || typeof receipt["state"] !== "object" || Array.isArray(receipt["state"]))))
        throw new Error("Invalid authoritative core receipt");
      if (input.action.kind === "token.light" && receipt["outcome"] === "confirmed") {
        if (Buffer.byteLength(JSON.stringify(receipt)) > 10000) throw new Error("Token light receipt budget exceeded");
        const state = receipt["state"] as Record<string, AiDmJsonValue>;
        const light = state["light"];
        if (!light || typeof light !== "object" || Array.isArray(light) ||
          !Object.entries(input.action.light).every(([key, value]) => key === "color" && typeof value === "string"
            ? String(light[key]).toLowerCase() === value.toLowerCase() : light[key] === value))
          throw new Error("Token light acknowledgement does not match requested fields");
      }
      result = receipt;
    } catch {
      result = { outcome: "uncertain", schemaVersion: CORE_PROTOCOL, worldId: scope.worldId, correlationId,
        action: input.action as AiDmJsonValue, state: null, mutated: false, message: input.action.kind === "token.light"
          ? "Token-light acknowledgement unavailable; verify loaded MCP token-light capability and GM connection, then inspect this placed token before a new request. Application is unconfirmed; this action will not be redispatched."
          : "Acknowledgement unavailable; inspect state before a new request. This action will not be redispatched." };
    }
    latencyEvent("core:execution-readback-ack", performance.now() - started);
    const persistStarted = performance.now();
    this.db.prepare("UPDATE chatkit_core_actions SET entry_json=? WHERE scope_key=?").run(JSON.stringify({ ...pending, result }), key);
    latencyEvent("core:receipt-persisted", performance.now() - persistStarted);
    console.info(JSON.stringify({ type: "core-timing", stage: "mcp-execution-and-ack", correlationId, durationMs: performance.now() - started,
      outcome: result && typeof result === "object" && !Array.isArray(result) ? result["outcome"] : "unavailable" }));
    return result;
  }
}

