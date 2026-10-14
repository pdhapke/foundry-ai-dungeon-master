import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { stableJson } from "../context/hash.js";
import { bounded } from "./bounded-call.js";
import type { SessionRequestAuthorization } from "./pause-request.js";

export const ATTACK_PROTOCOL = "attack-actions-v1";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const attackActionSchema = z.union([
  z.object({ mode: z.literal("roll"), sceneId: id, attackerTokenId: id, actorId: id, itemId: id, activityId: id, targetTokenId: id,
    advantage: z.enum(["normal", "advantage", "disadvantage"]), attackMode: id.optional(), ammunitionId: id.optional(), abilityId: id.optional() }).strict(),
  z.object({ mode: z.literal("apply"), priorAttackRequestId: id, decisionId: id.optional() }).strict(),
]);
type Scope = { worldId: string; userId: string; threadId: string };
const requestSchema = z.object({ actionId: id, action: attackActionSchema }).strict();
const hpSchema = z.object({ value: z.number().finite(), temp: z.number().finite(), max: z.number().finite() }).passthrough();
const rollSchema = z.object({ formula: z.string().max(2000), total: z.number().finite(), result: z.string().max(2000) }).passthrough();
export const stateSchema = z.object({ systemId: z.literal("dnd5e"), systemVersion: z.string().max(64), attackRequestId: id,
  stage: z.enum(["attack-rolled", "damage-rolled", "damage-applied", "miss", "cancelled"]), source: z.object({ sceneId: id, attackerTokenId: id, actorId: id, itemId: id, activityId: id, targetTokenId: id }).strict(),
  attackRoll: rollSchema.nullable(), hit: z.boolean().nullable(), critical: z.boolean(), damageRolls: z.array(rollSchema).max(16),
  damageRolled: z.number().finite().min(0), damageApplied: z.number().finite().min(0).nullable(), hpBefore: hpSchema, hpAfter: hpSchema.nullable(),
  decisions: z.array(z.object({ id, kind: z.string().max(128), message: z.string().max(1000) }).passthrough()).max(16) }).passthrough();

/** Existing session policy, live authentication and durable claims; no discovery and no rules engine. */
export class ChatKitAttackActions {
  constructor(private readonly client: FoundryLocalApiMcpClient, private readonly db: DatabaseSync,
    private readonly authorize: (identity: AiDmAuthenticatedIdentity, signal: AbortSignal) => Promise<void>, private readonly timeoutMs = 10000) {
    db.exec("CREATE TABLE IF NOT EXISTS chatkit_attack_actions(scope_key TEXT PRIMARY KEY,entry_json TEXT NOT NULL)");
  }
  private async check(identity: AiDmAuthenticatedIdentity, scope: Scope, signal: AbortSignal) {
    if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId || !scope.threadId) throw new Error("Current authenticated GM world required");
    signal.throwIfAborted(); await bounded(this.authorize(identity, signal), signal); signal.throwIfAborted();
  }
  recent(scope: Scope): AiDmJsonValue[] {
    return this.db.prepare("SELECT entry_json FROM chatkit_attack_actions ORDER BY rowid DESC LIMIT 100").all().map(row => JSON.parse(String(row["entry_json"])) as Record<string, AiDmJsonValue>)
      .filter(entry => stableJson(entry["scope"]) === stableJson(scope)).slice(0, 12);
  }
  async read(identity: AiDmAuthenticatedIdentity, scope: Scope, args: unknown, outerSignal: AbortSignal): Promise<AiDmJsonValue> {
    const input = z.object({ sceneId: id.optional(), actorId: id.optional(), requestId: id.optional() }).strict().parse(args);
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    await this.check(identity, scope, signal);
    const result = await bounded(this.client.callTool({ name: "foundry_attack_state", arguments: { ...input, worldId: scope.worldId, userId: scope.userId, schemaVersion: ATTACK_PROTOCOL } as AiDmJsonValue, idempotencyKey: null },
      { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }), signal);
    await this.check(identity, scope, signal);
    if (!result || typeof result !== "object" || Array.isArray(result) || result["schemaVersion"] !== ATTACK_PROTOCOL || result["worldId"] !== scope.worldId || result["userId"] !== scope.userId || Buffer.byteLength(JSON.stringify(result)) > 24000)
      throw new Error("Invalid bounded attack state");
    return { ...result, trust: "untrusted-source-data", recentAttackReceipts: this.recent(scope) };
  }
  async request(identity: AiDmAuthenticatedIdentity, scope: Scope, args: unknown, authority: SessionRequestAuthorization | undefined, outerSignal: AbortSignal): Promise<AiDmJsonValue> {
    const input = requestSchema.parse(args);
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    await this.check(identity, scope, signal);
    if (!authority?.worldControl?.manualRequest || !/^[a-f0-9]{64}$/.test(authority.worldControl.requestDigest)) throw new Error("Current manual GM request required");
    if (input.action.mode === "apply") {
      const priorRequestId = input.action.priorAttackRequestId;
      const prior = this.recent(scope).find(entry => entry && typeof entry === "object" && !Array.isArray(entry) && entry["requestId"] === priorRequestId);
      if (!prior || typeof prior !== "object" || Array.isArray(prior)) throw new Error("Prior attack receipt not in this conversation; reconcile instead of guessing");
      if (input.action.decisionId && (authority.attackDecision?.priorAttackRequestId !== input.action.priorAttackRequestId || authority.attackDecision.decisionId !== input.action.decisionId))
        throw new Error("Attack decision requires authenticated direct human action");
      if (input.action.decisionId) {
        const priorResult = prior["result"] as Record<string, AiDmJsonValue>;
        const priorState = priorResult?.["state"] as Record<string, AiDmJsonValue>;
        const decisionId = input.action.decisionId;
        if (!Array.isArray(priorState?.["decisions"]) || !priorState["decisions"].some(value => value && typeof value === "object" && !Array.isArray(value) && value["id"] === decisionId))
          throw new Error("Attack decision ticket not in this conversation receipt");
      }
    }
    const key = stableJson([scope.worldId, scope.userId, scope.threadId, input.actionId]);
    const load = () => { const row = this.db.prepare("SELECT entry_json FROM chatkit_attack_actions WHERE scope_key=?").get(key); return row ? JSON.parse(String(row["entry_json"])) as Record<string, AiDmJsonValue> : undefined; };
    const prior = load();
    if (prior) { if (stableJson(prior["action"]) !== stableJson(input.action)) throw new Error("Attack action ID conflict"); return prior["result"] ?? { outcome: "uncertain", message: "Previously dispatched attack unresolved; do not reroll or reapply." }; }
    const unresolved = this.db.prepare("SELECT entry_json FROM chatkit_attack_actions").all().some(row => {
      const entry = JSON.parse(String(row["entry_json"])) as Record<string, AiDmJsonValue>;
      const entryScope = entry["scope"] as Record<string, AiDmJsonValue>;
      const storedResult = entry["result"] as Record<string, AiDmJsonValue> | undefined;
      return entryScope["worldId"] === scope.worldId && (!storedResult || storedResult["outcome"] === "uncertain");
    });
    if (unresolved) throw new Error("Unresolved attack in this world; reconcile stored receipts before a fresh attack ID");
    const requestId = createHash("sha256").update(key).digest("hex"), correlationId = `aidm-${randomUUID()}`;
    const pending = { scope, actionId: input.actionId, action: input.action, requestId, correlationId };
    const claim = this.db.prepare("INSERT INTO chatkit_attack_actions VALUES (?,?) ON CONFLICT(scope_key) DO NOTHING").run(key, JSON.stringify(pending));
    if (!claim.changes) { const winner = load()!; if (stableJson(winner["action"]) !== stableJson(input.action)) throw new Error("Attack action ID conflict"); return winner["result"] ?? { outcome: "uncertain", message: "Previously dispatched attack unresolved; reconcile." }; }
    let result: AiDmJsonValue;
    try {
      await this.check(identity, scope, signal);
      const receipt = await bounded(this.client.callTool({ name: "foundry_attack_confirmed", arguments: { schemaVersion: ATTACK_PROTOCOL, worldId: scope.worldId, userId: scope.userId,
        requestId, correlationId, origin: "ai-dm", action: input.action as AiDmJsonValue }, idempotencyKey: null }, { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }), signal);
      await this.check(identity, scope, signal);
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt["worldId"] !== scope.worldId || receipt["userId"] !== scope.userId || receipt["schemaVersion"] !== ATTACK_PROTOCOL || receipt["requestId"] !== requestId || receipt["correlationId"] !== correlationId ||
        stableJson(receipt["action"]) !== stableJson(input.action) || !["confirmed", "failure", "uncertain", "decision-required"].includes(String(receipt["outcome"])) || typeof receipt["mutated"] !== "boolean" || Buffer.byteLength(JSON.stringify(receipt)) > 24000)
        throw new Error("Invalid authoritative attack receipt");
      if (receipt["outcome"] === "confirmed" || receipt["outcome"] === "decision-required") {
        const state = stateSchema.parse(receipt["state"]);
        const originating = input.action.mode === "roll" ? input.action : (() => {
          const entry = this.recent(scope).find(value => value && typeof value === "object" && !Array.isArray(value) && value["requestId"] === (input.action as { priorAttackRequestId: string }).priorAttackRequestId) as Record<string, AiDmJsonValue>;
          return attackActionSchema.parse(entry["action"]);
        })();
        if (originating.mode !== "roll" || ["sceneId", "attackerTokenId", "actorId", "itemId", "activityId", "targetTokenId"].some(field =>
          (state.source as Record<string, unknown>)[field] !== (originating as Record<string, unknown>)[field])) throw new Error("Attack source evidence drift");
        const originRequest = input.action.mode === "roll" ? requestId : input.action.priorAttackRequestId;
        if (state.attackRequestId !== originRequest) throw new Error("Attack roll identity drift");
        if (state.stage === "damage-applied" && (state.hit !== true || state.hpAfter === null || state.damageApplied === null ||
          Math.abs((state.hpBefore.value - state.hpAfter.value) + (state.hpBefore.temp - state.hpAfter.temp) - state.damageApplied) > 1e-8))
          throw new Error("Missing or inconsistent authoritative damage application evidence");
        if (["attack-rolled", "damage-rolled", "miss"].includes(state.stage) && !state.attackRoll) throw new Error("Missing attack roll evidence");
        if (state.stage === "miss" && state.hit !== false) throw new Error("Invalid miss receipt");
      }
      result = receipt;
    } catch {
      result = { schemaVersion: ATTACK_PROTOCOL, worldId: scope.worldId, userId: scope.userId, requestId, correlationId, action: input.action as AiDmJsonValue, outcome: "uncertain", mutated: false, state: null,
        message: "Attack acknowledgement unavailable. Do not reroll, reapply damage, consume resources, or change action ID; reconcile the stored native receipt." };
    }
    this.db.prepare("UPDATE chatkit_attack_actions SET entry_json=? WHERE scope_key=?").run(JSON.stringify({ ...pending, result }), key);
    return result;
  }
}
