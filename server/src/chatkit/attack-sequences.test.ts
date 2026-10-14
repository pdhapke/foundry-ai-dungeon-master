import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ChatKitAttackSequences } from "./attack-sequences.js";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
const identity: AiDmAuthenticatedIdentity = {
    worldId: "world",
    userId: "gm",
    clientId: "client",
    lane: "gm",
    isGm: true,
  },
  scope = { worldId: "world", userId: "gm", threadId: "thread" },
  authority = { worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) } };
const attack = {
  mode: "roll" as const,
  sceneId: "scene",
  attackerTokenId: "attacker",
  actorId: "actor",
  itemId: "item",
  activityId: "activity",
  targetTokenId: "target",
  advantage: "normal" as const,
};
const action = {
  mode: "execute" as const,
  steps: [{ stepId: "one", attack }],
  maxDurationMs: 8000,
};
function fixture(drift = false, lose = false) {
  const db = new DatabaseSync(":memory:");
  let calls = 0,
    revoked = false;
  const client: FoundryLocalApiMcpClient = {
    listTools: async () => [],
    callTool: async (call) => {
      calls++;
      if (lose) throw Error("lost");
      const input = call.arguments as Record<string, AiDmJsonValue>,
        origin = String(input["requestId"]),
        rollId = createHash("sha256")
          .update(JSON.stringify([origin, "one", "roll"]))
          .digest("hex");
      const roll = {
        schemaVersion: "attack-actions-v1",
        worldId: "world",
        userId: "gm",
        requestId: rollId,
        correlationId: input["correlationId"],
        action: attack,
        outcome: "confirmed",
        mutated: false,
        state: {
          systemId: "dnd5e",
          systemVersion: "6.0.3",
          attackRequestId: rollId,
          stage: "miss",
          source: {
            sceneId: "scene",
            attackerTokenId: "attacker",
            actorId: "actor",
            itemId: "item",
            activityId: "activity",
            targetTokenId: drift ? "other" : "target",
          },
          attackRoll: { formula: "1d20+4", total: 5, result: "1+4" },
          hit: false,
          critical: false,
          damageRolls: [],
          damageRolled: 0,
          damageApplied: null,
          hpBefore: { value: 20, temp: 0, max: 20 },
          hpAfter: null,
          decisions: [],
        },
      };
      return {
        ...input,
        outcome: "confirmed",
        mutated: false,
        state: {
          sequenceRequestId: origin,
          plan: action.steps,
          completedStepCount: 1,
          steps: [{ stepId: "one", rollReceipt: roll, applyReceipt: null }],
          continuation: null,
          limitations: [],
        },
      } as AiDmJsonValue;
    },
  };
  return {
    db,
    service: new ChatKitAttackSequences(client, db, async () => {
      if (revoked) throw Error("revoked");
    }),
    get calls() {
      return calls;
    },
    revoke() {
      revoked = true;
    },
  };
}
void test("sequence scoped stable replay and changed ID arguments/auth fail without redispatch", async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal,
      r = (await f.service.request(
        identity,
        scope,
        { actionId: "stable", action },
        authority,
        signal,
      )) as Record<string, AiDmJsonValue>;
    assert.equal(r["outcome"], "confirmed");
    await f.service.request(identity, scope, { actionId: "stable", action }, authority, signal);
    assert.equal(f.calls, 1);
    await assert.rejects(
      f.service.request(
        identity,
        scope,
        { actionId: "stable", action: { ...action, maxDurationMs: 7000 } },
        authority,
        signal,
      ),
      /conflict/,
    );
    f.revoke();
    await assert.rejects(
      f.service.request(identity, scope, { actionId: "stable", action }, authority, signal),
      /revoked/,
    );
  } finally {
    f.db.close();
  }
});
void test("source drift or lost receipt fences fresh IDs and original replay never rerolls", async () => {
  for (const args of [
    [true, false],
    [false, true],
  ]) {
    const f = fixture(...(args as [boolean, boolean]));
    try {
      const signal = new AbortController().signal,
        r = (await f.service.request(
          identity,
          scope,
          { actionId: "one", action },
          authority,
          signal,
        )) as Record<string, AiDmJsonValue>;
      assert.equal(r["outcome"], "uncertain");
      await f.service.request(identity, scope, { actionId: "one", action }, authority, signal);
      await assert.rejects(
        f.service.request(identity, scope, { actionId: "two", action }, authority, signal),
        /reconcile/,
      );
      assert.equal(f.calls, 1);
    } finally {
      f.db.close();
    }
  }
});
void test("resume ticket cannot leave its conversation and models cannot resolve reactions", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.service.request(
        identity,
        scope,
        {
          actionId: "resume",
          action: {
            mode: "resume",
            priorSequenceRequestId: "missing",
            continuationId: "ticket",
            maxDurationMs: 8000,
          },
        },
        authority,
        new AbortController().signal,
      ),
      /conversation/,
    );
    assert.equal(f.calls, 0);
  } finally {
    f.db.close();
  }
});

void test("pending durable crash claim reopens and does not dispatch; isolation remains enforced", async () => {
  const f = fixture();
  try {
    const key = JSON.stringify([scope.worldId, scope.userId, scope.threadId, "pending"]);
    f.db
      .prepare("INSERT INTO chatkit_attack_sequences VALUES (?,?)")
      .run(
        key,
        JSON.stringify({
          scope,
          actionId: "pending",
          action,
          requestId: "stored",
          correlationId: "stored",
        }),
      );
    const reopened = new ChatKitAttackSequences(
      {
        listTools: async () => [],
        callTool: async () => {
          assert.fail("pending rerolled");
        },
      },
      f.db,
      async () => {},
    );
    const result = (await reopened.request(
      identity,
      scope,
      { actionId: "pending", action },
      authority,
      new AbortController().signal,
    )) as Record<string, AiDmJsonValue>;
    assert.equal(result["outcome"], "uncertain");
    await assert.rejects(
      reopened.request(
        { ...identity, worldId: "other" },
        scope,
        { actionId: "pending", action },
        authority,
        new AbortController().signal,
      ),
      /world/,
    );
  } finally {
    f.db.close();
  }
});
void test("clean deadline resume preserves cumulative plan and old correlation without reroll", async () => {
  const db = new DatabaseSync(":memory:");
  let calls = 0,
    origin = "",
    first: any;
  const plan = [
    { stepId: "one", attack },
    { stepId: "two", attack },
  ];
  const miss = (stepId: string, correlationId: unknown) => {
    const rollId = createHash("sha256")
      .update(JSON.stringify([origin, stepId, "roll"]))
      .digest("hex");
    return {
      stepId,
      rollReceipt: {
        schemaVersion: "attack-actions-v1",
        worldId: "world",
        userId: "gm",
        requestId: rollId,
        correlationId,
        action: attack,
        outcome: "confirmed",
        mutated: false,
        state: {
          systemId: "dnd5e",
          systemVersion: "6.0.3",
          attackRequestId: rollId,
          stage: "miss",
          source: {
            sceneId: "scene",
            attackerTokenId: "attacker",
            actorId: "actor",
            itemId: "item",
            activityId: "activity",
            targetTokenId: "target",
          },
          attackRoll: { formula: "1d20+4", total: 5, result: "1+4" },
          hit: false,
          critical: false,
          damageRolls: [],
          damageRolled: 0,
          damageApplied: null,
          hpBefore: { value: 20, temp: 0, max: 20 },
          hpAfter: null,
          decisions: [],
        },
      },
      applyReceipt: null,
    };
  };
  const client: FoundryLocalApiMcpClient = {
    listTools: async () => [],
    callTool: async (call) => {
      calls++;
      const input = call.arguments as Record<string, AiDmJsonValue>;
      if (calls === 1) {
        origin = String(input["requestId"]);
        first = miss("one", input["correlationId"]);
      }
      return {
        ...input,
        outcome: calls === 1 ? "partial" : "confirmed",
        mutated: false,
        state: {
          sequenceRequestId: origin,
          plan,
          completedStepCount: calls === 1 ? 1 : 2,
          steps: calls === 1 ? [first] : [first, miss("two", input["correlationId"])],
          continuation:
            calls === 1 ? { id: "ticket", priorSequenceRequestId: origin, nextStepIndex: 1 } : null,
          limitations: [],
        },
      } as AiDmJsonValue;
    },
  };
  try {
    const service = new ChatKitAttackSequences(client, db, async () => {}),
      signal = new AbortController().signal;
    const initial: any = await service.request(
      identity,
      scope,
      { actionId: "original", action: { mode: "execute", steps: plan, maxDurationMs: 1000 } },
      authority,
      signal,
    );
    assert.equal(initial.outcome, "partial");
    const resumed: any = await service.request(
      identity,
      scope,
      {
        actionId: "continuation",
        action: {
          mode: "resume",
          priorSequenceRequestId: origin,
          continuationId: "ticket",
          maxDurationMs: 8000,
        },
      },
      authority,
      signal,
    );
    assert.equal(resumed.outcome, "confirmed");
    assert.equal(resumed.state.completedStepCount, 2);
    assert.deepEqual(resumed.state.steps[0], initial.state.steps[0]);
    await service.request(
      identity,
      scope,
      {
        actionId: "continuation",
        action: {
          mode: "resume",
          priorSequenceRequestId: origin,
          continuationId: "ticket",
          maxDurationMs: 8000,
        },
      },
      authority,
      signal,
    );
    assert.equal(calls, 2);
  } finally {
    db.close();
  }
});
