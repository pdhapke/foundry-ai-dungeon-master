import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { stableJson } from "../context/hash.js";
import { bounded } from "./bounded-call.js";
import { attackActionSchema, stateSchema } from "./attack-actions.js";
import type { SessionRequestAuthorization } from "./pause-request.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const executeSchema = z
  .object({
    mode: z.literal("execute"),
    steps: z
      .array(z.object({ stepId: id, attack: attackActionSchema }).strict())
      .min(1)
      .max(4),
    maxDurationMs: z.number().int().min(1000).max(8000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.steps.some((step) => step.attack.mode !== "roll"))
      ctx.addIssue({ code: "custom", message: "Sequence steps require explicit roll actions" });
    if (new Set(value.steps.map((step) => step.stepId)).size !== value.steps.length)
      ctx.addIssue({ code: "custom", message: "Duplicate step IDs" });
  });
export const attackSequenceSchema = z.union([
  executeSchema,
  z
    .object({
      mode: z.literal("resume"),
      priorSequenceRequestId: id,
      continuationId: id,
      maxDurationMs: z.number().int().min(1000).max(8000),
    })
    .strict(),
]);
const requestSchema = z.object({ actionId: id, action: attackSequenceSchema }).strict();
type Scope = { worldId: string; userId: string; threadId: string };
const object = (v: unknown): Record<string, AiDmJsonValue> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Malformed sequence receipt");
  return v as Record<string, AiDmJsonValue>;
};
/** Native system owns rules and durable steps. This boundary never retries a lost dispatch. */
export class ChatKitAttackSequences {
  constructor(
    private client: FoundryLocalApiMcpClient,
    private db: DatabaseSync,
    private authorize: (identity: AiDmAuthenticatedIdentity, signal: AbortSignal) => Promise<void>,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS chatkit_attack_sequences(scope_key TEXT PRIMARY KEY,entry_json TEXT NOT NULL)",
    );
  }
  private async check(identity: AiDmAuthenticatedIdentity, scope: Scope, signal: AbortSignal) {
    if (
      !identity.isGm ||
      identity.worldId !== scope.worldId ||
      identity.userId !== scope.userId ||
      !scope.threadId
    )
      throw Error("Current GM world required");
    signal.throwIfAborted();
    await bounded(this.authorize(identity, signal), signal);
    signal.throwIfAborted();
  }
  recent(scope: Scope): AiDmJsonValue[] {
    return this.db
      .prepare("SELECT entry_json FROM chatkit_attack_sequences ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(String(row["entry_json"])) as Record<string, AiDmJsonValue>)
      .filter((entry) => stableJson(entry["scope"]) === stableJson(scope))
      .slice(0, 12);
  }
  async request(
    identity: AiDmAuthenticatedIdentity,
    scope: Scope,
    args: unknown,
    authority: SessionRequestAuthorization | undefined,
    outer: AbortSignal,
  ): Promise<AiDmJsonValue> {
    const input = requestSchema.parse(args),
      signal = AbortSignal.any([outer, AbortSignal.timeout(10000)]);
    await this.check(identity, scope, signal);
    if (
      !authority?.worldControl?.manualRequest ||
      !/^[a-f0-9]{64}$/.test(authority.worldControl.requestDigest)
    )
      throw Error("Current manual GM request required");
    let originalPlan: z.infer<typeof executeSchema>["steps"];
    let originRequest: string | undefined;
    let previousSteps: AiDmJsonValue[] = [];
    if (input.action.mode === "resume") {
      const priorId = input.action.priorSequenceRequestId;
      const prior = this.recent(scope)
        .map(object)
        .find((entry) => entry["requestId"] === priorId);
      if (!prior || !prior["result"]) throw Error("Prior sequence not in this conversation");
      const result = object(prior["result"]),
        state = object(result["state"]),
        ticket = object(state["continuation"]);
      if (
        result["outcome"] !== "partial" ||
        ticket["id"] !== input.action.continuationId ||
        ticket["priorSequenceRequestId"] !== input.action.priorSequenceRequestId
      )
        throw Error("Exact clean continuation required");
      originalPlan = executeSchema.parse({
        mode: "execute",
        steps: state["plan"],
        maxDurationMs: input.action.maxDurationMs,
      }).steps;
      originRequest = String(state["sequenceRequestId"]);
      previousSteps = Array.isArray(state["steps"]) ? state["steps"] : [];
    } else originalPlan = input.action.steps;
    const key = stableJson([scope.worldId, scope.userId, scope.threadId, input.actionId]);
    const old = this.db
      .prepare("SELECT entry_json FROM chatkit_attack_sequences WHERE scope_key=?")
      .get(key);
    if (old) {
      const entry = object(JSON.parse(String(old["entry_json"])));
      if (stableJson(entry["action"]) !== stableJson(input.action))
        throw Error("Sequence action ID conflict");
      return (
        entry["result"] ?? {
          outcome: "uncertain",
          message: "Previously dispatched sequence unresolved; reconcile, do not reroll.",
        }
      );
    }
    for (const row of this.db.prepare("SELECT entry_json FROM chatkit_attack_sequences").all()) {
      const entry = object(JSON.parse(String(row["entry_json"])));
      if (
        object(entry["scope"])["worldId"] === scope.worldId &&
        (!entry["result"] || object(entry["result"])["outcome"] === "uncertain")
      )
        throw Error("Unresolved sequence; reconcile before fresh IDs");
    }
    const requestId = createHash("sha256").update(key).digest("hex"),
      correlationId = `aidm-${randomUUID()}`,
      pending = { scope, actionId: input.actionId, action: input.action, requestId, correlationId };
    this.db
      .prepare("INSERT INTO chatkit_attack_sequences VALUES (?,?)")
      .run(key, JSON.stringify(pending));
    let result: AiDmJsonValue;
    try {
      await this.check(identity, scope, signal);
      const raw = await bounded(
        this.client.callTool(
          {
            name: "foundry_attack_sequence_confirmed",
            arguments: {
              schemaVersion: "attack-sequence-v1",
              worldId: scope.worldId,
              userId: scope.userId,
              requestId,
              correlationId,
              origin: "ai-dm",
              action: input.action,
            } as AiDmJsonValue,
            idempotencyKey: null,
          },
          { signal, timeout: 10000, maxTotalTimeout: 10000 },
        ),
        signal,
      );
      await this.check(identity, scope, signal);
      const receipt = object(raw);
      if (
        receipt["schemaVersion"] !== "attack-sequence-v1" ||
        receipt["worldId"] !== scope.worldId ||
        receipt["userId"] !== scope.userId ||
        receipt["requestId"] !== requestId ||
        receipt["correlationId"] !== correlationId ||
        stableJson(receipt["action"]) !== stableJson(input.action) ||
        typeof receipt["mutated"] !== "boolean" ||
        !["confirmed", "partial", "decision-required", "failure", "uncertain"].includes(
          String(receipt["outcome"]),
        ) ||
        Buffer.byteLength(JSON.stringify(receipt)) > 24000
      )
        throw Error("Invalid sequence identity");
      if (receipt["state"] === null) {
        if (!["failure", "uncertain"].includes(String(receipt["outcome"])))
          throw Error("Missing sequence state");
        result = receipt;
      } else {
        const state = object(receipt["state"]),
          origin = originRequest ?? requestId;
        if (
          state["sequenceRequestId"] !== origin ||
          stableJson(state["plan"]) !== stableJson(originalPlan) ||
          !Array.isArray(state["steps"]) ||
          state["steps"].length > originalPlan.length ||
          !Number.isInteger(state["completedStepCount"]) ||
          Number(state["completedStepCount"]) < 0 ||
          Number(state["completedStepCount"]) > state["steps"].length
        )
          throw Error("Invalid sequence progress");
        let completed = 0;
        let childMutated = false;
        state["steps"].forEach((value, index) => {
          if (
            index < previousSteps.length &&
            stableJson(value) !== stableJson(previousSteps[index])
          )
            throw Error("Previously completed receipt drift");
          const step = object(value),
            planned = originalPlan[index]!;
          if (step["stepId"] !== planned.stepId) throw Error("Sequence step drift");
          const rollId = createHash("sha256")
            .update(JSON.stringify([origin, planned.stepId, "roll"]))
            .digest("hex");
          let rollState: ReturnType<typeof stateSchema.parse> | undefined,
            applyState: ReturnType<typeof stateSchema.parse> | undefined;
          for (const phase of ["roll", "apply"]) {
            const child = step[phase + "Receipt"];
            if (child === null && phase === "apply") continue;
            const item = object(child),
              expected = createHash("sha256")
                .update(JSON.stringify([origin, planned.stepId, phase]))
                .digest("hex");
            if (
              item["requestId"] !== expected ||
              item["worldId"] !== scope.worldId ||
              item["userId"] !== scope.userId ||
              item["schemaVersion"] !== "attack-actions-v1" ||
              !["confirmed", "failure", "uncertain", "decision-required"].includes(
                String(item["outcome"]),
              ) ||
              typeof item["mutated"] !== "boolean"
            )
              throw Error("Sequence child identity drift");
            if (index >= previousSteps.length && item["correlationId"] !== correlationId)
              throw Error("Child correlation drift");
            childMutated ||= item["mutated"] === true;
            const expectedAction =
              phase === "roll" ? planned.attack : { mode: "apply", priorAttackRequestId: rollId };
            if (stableJson(item["action"]) !== stableJson(expectedAction))
              throw Error("Child action drift");
            if (item["outcome"] !== "confirmed") continue;
            const childState = stateSchema.parse(item["state"]);
            if (
              childState.attackRequestId !== rollId ||
              [
                "sceneId",
                "attackerTokenId",
                "actorId",
                "itemId",
                "activityId",
                "targetTokenId",
              ].some(
                (field) =>
                  (childState.source as Record<string, unknown>)[field] !==
                  (planned.attack as Record<string, unknown>)[field],
              )
            )
              throw Error("Child source drift");
            if (
              phase === "roll" &&
              (!childState.attackRoll || !["miss", "damage-rolled"].includes(childState.stage))
            )
              throw Error("Missing completed native roll");
            if (
              childState.stage === "miss" &&
              (childState.hit !== false ||
                childState.critical ||
                childState.damageRolled !== 0 ||
                childState.damageRolls.length ||
                childState.damageApplied !== null ||
                childState.hpAfter !== null)
            )
              throw Error("Invalid miss evidence");
            if (
              phase === "roll" &&
              childState.stage === "damage-rolled" &&
              (childState.hit !== true ||
                childState.damageApplied !== null ||
                childState.hpAfter !== null)
            )
              throw Error("Roll falsely applied damage");
            if (
              childState.attackRoll &&
              typeof childState.attackRoll["isCritical"] === "boolean" &&
              childState.critical !== childState.attackRoll["isCritical"]
            )
              throw Error("Critical evidence drift");
            if (
              childState.damageRolls.some((roll) => roll.total < 0) ||
              Math.abs(
                childState.damageRolls.reduce((total, roll) => total + roll.total, 0) -
                  childState.damageRolled,
              ) > 1e-8
            )
              throw Error("Damage roll evidence drift");
            const resources = childState["resourceConsumption"];
            if (resources !== undefined) {
              const evidence = object(resources);
              if (
                evidence["verified"] !== true ||
                !Array.isArray(evidence["before"]) ||
                !Array.isArray(evidence["after"]) ||
                !evidence["before"].length ||
                evidence["before"].length !== evidence["after"].length
              )
                throw Error("Unverified resources");
              evidence["before"].forEach((value, i) => {
                const before = object(value),
                  after = evidence["after"] as AiDmJsonValue[];
                if (
                  typeof before["spent"] !== "number" ||
                  typeof before["cost"] !== "number" ||
                  !Number.isFinite(before["spent"]) ||
                  !Number.isSafeInteger(before["cost"]) ||
                  after[i] !== before["spent"] + before["cost"]
                )
                  throw Error("Resource consumption drift");
              });
            }
            if (phase === "roll") rollState = childState;
            else applyState = childState;
          }
          if (rollState?.hit === false && rollState.stage === "miss") completed++;
          else if (
            rollState?.hit === true &&
            applyState?.stage === "damage-applied" &&
            applyState.hit === true &&
            applyState.hpAfter &&
            applyState.damageApplied !== null &&
            Math.abs(
              applyState.hpBefore.value -
                applyState.hpAfter.value +
                (applyState.hpBefore.temp - applyState.hpAfter.temp) -
                applyState.damageApplied,
            ) < 1e-8
          )
            completed++;
          else if (index < Number(state["completedStepCount"]))
            throw Error("Unconfirmed completed step");
        });
        if (childMutated && receipt["mutated"] !== true)
          throw Error("Sequence mutation evidence drift");
        if (completed !== state["completedStepCount"]) throw Error("Completed count drift");
        if (receipt["outcome"] === "confirmed" && completed !== originalPlan.length)
          throw Error("Incomplete sequence cannot confirm");
        if (state["continuation"] !== null) {
          const ticket = object(state["continuation"]);
          if (
            receipt["outcome"] !== "partial" ||
            state["steps"].length !== completed ||
            ticket["priorSequenceRequestId"] !== requestId ||
            ticket["nextStepIndex"] !== completed ||
            !id.safeParse(ticket["id"]).success
          )
            throw Error("Unsafe continuation");
        }
      }
      result = receipt;
    } catch {
      result = {
        schemaVersion: "attack-sequence-v1",
        worldId: scope.worldId,
        userId: scope.userId,
        requestId,
        correlationId,
        action: input.action as AiDmJsonValue,
        outcome: "uncertain",
        mutated: false,
        state: null,
        message:
          "Sequence acknowledgement unavailable; reconcile recorded steps. Do not reroll, reapply or consume resources again.",
      };
    }
    this.db
      .prepare("UPDATE chatkit_attack_sequences SET entry_json=? WHERE scope_key=?")
      .run(JSON.stringify({ ...pending, result }), key);
    return result;
  }
}
