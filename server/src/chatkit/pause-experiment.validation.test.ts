import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ChatKitPauseActions } from "./pause-actions.js";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
const gm: AiDmAuthenticatedIdentity = {
  worldId: "w",
  userId: "gm",
  isGm: true,
  clientId: "client",
  lane: "gm",
};
const object = (value: AiDmJsonValue) => value as Record<string, AiDmJsonValue>;
const scope = { worldId: "w", userId: "gm", threadId: "t" };
function fixture() {
  const db = new DatabaseSync(":memory:");
  let calls = 0;
  let revoked = false;
  let ambiguous = false;
  const client: FoundryLocalApiMcpClient = {
    listTools() {
      assert.fail("core loaded discovery schema");
    },
    callTool(call) {
      calls++;
      if (ambiguous) return Promise.reject(new Error("timeout"));
      return Promise.resolve({
        outcome: "confirmed",
        paused: object(call.arguments)["paused"]!,
        worldId: "w",
        correlationId: object(call.arguments)["correlationId"]!,
        mutated: true,
      });
    },
  };
  const service = new ChatKitPauseActions(client, db, () =>
    revoked ? Promise.reject(new Error("revoked")) : Promise.resolve(),
  );
  return {
    db,
    service,
    get calls() {
      return calls;
    },
    revoke() {
      revoked = true;
    },
    ambiguous() {
      ambiguous = true;
    },
  };
}
void test("independent core validates identity/args and needs one MCP call with no discovery/read", async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    await assert.rejects(
      f.service.setConfirmed(
        { ...gm, isGm: false },
        scope,
        { actionId: "a", paused: true },
        true,
        signal,
      ),
    );
    await assert.rejects(
      f.service.setConfirmed(
        gm,
        { ...scope, worldId: "bad" },
        { actionId: "a", paused: true },
        true,
        signal,
      ),
    );
    await assert.rejects(
      f.service.setConfirmed(gm, scope, { actionId: "a", paused: "true" }, true, signal),
    );
    const a = { actionId: "a", paused: true };
    assert.equal(
      ((await f.service.setConfirmed(gm, scope, a, true, signal)) as Record<string, AiDmJsonValue>)
        .outcome,
      "confirmed",
    );
    await f.service.setConfirmed(gm, scope, a, true, signal);
    assert.equal(f.calls, 1);
    await assert.rejects(f.service.setConfirmed(gm, scope, { ...a, paused: false }, false, signal));
    f.revoke();
    await assert.rejects(f.service.setConfirmed(gm, scope, a, true, signal));
    assert.equal(f.calls, 1);
  } finally {
    f.db.close();
  }
});
void test("independent core ambiguous receipt persists across service recreation without redispatch", async () => {
  const f = fixture();
  try {
    f.ambiguous();
    const signal = new AbortController().signal;
    const a = { actionId: "b", paused: false };
    assert.equal(
      ((await f.service.setConfirmed(gm, scope, a, false, signal)) as Record<string, AiDmJsonValue>)
        .outcome,
      "uncertain",
    );
    const recovered = new ChatKitPauseActions(
      {
        listTools() {
          assert.fail();
        },
        callTool() {
          assert.fail("retry mutation");
        },
      },
      f.db,
      () => Promise.resolve(),
    );
    assert.equal(
      ((await recovered.setConfirmed(gm, scope, a, false, signal)) as Record<string, AiDmJsonValue>)
        .outcome,
      "uncertain",
    );
    assert.equal(f.calls, 1);
  } finally {
    f.db.close();
  }
});
void test("independent core exposes durable receipt in same-scope history and isolates other worlds", async () => {
  const f = fixture();
  try {
    await f.service.setConfirmed(
      gm,
      scope,
      { actionId: "history", paused: true },
      true,
      new AbortController().signal,
    );
    const history = f.service.recent(scope) as Array<Record<string, AiDmJsonValue>>;
    assert.equal(history.length, 1);
    assert.equal(object(history[0]!["result"]!)["outcome"], "confirmed");
    assert.equal(f.service.recent({ ...scope, worldId: "other" }).length, 0);
  } finally {
    f.db.close();
  }
});
