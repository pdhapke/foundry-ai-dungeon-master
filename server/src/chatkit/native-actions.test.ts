import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { ChatKitNativeActions } from "./native-actions.js";

const identity = { worldId: "world", userId: "gm", isGm: true } as AiDmAuthenticatedIdentity;
const scope = { worldId: "world", userId: "gm", threadId: "thread" };
const signal = () => new AbortController().signal;
const object = (value: AiDmJsonValue) => value as Record<string, AiDmJsonValue>;
function fixture(timeout = 1000, databasePath = ":memory:") {
  const db = new DatabaseSync(databasePath);
  let authorized = true,
    active = "scene",
    clock = 1000;
  const calls: Array<{ name: string; arguments: AiDmJsonValue }> = [];
  let effect: (name: string, input: AiDmJsonValue) => Promise<AiDmJsonValue> = async (
    name,
    input,
  ) => {
    await Promise.resolve();
    if (name === "foundry_roll_dice")
      return {
        formula: object(input)["formula"]!,
        total: 7,
        result: "4 + 3",
        dice: [{ faces: 6, results: [4] }],
      };
    const manifest = object(input);
    const operation = object((manifest["operations"] as AiDmJsonValue[])[0]!);
    return {
      transactionId: manifest["correlationId"]!,
      idempotencyKey: manifest["idempotencyKey"]!,
      committed: true,
      operations: [
        {
          operationId: "session-note",
          kind: "document.create",
          documentType: "JournalEntry",
          documentId: object(operation["data"]!)["_id"]!,
          revision: "a".repeat(64),
        },
      ],
    };
  };
  const client: FoundryLocalApiMcpClient = {
    listTools: () =>
      Promise.resolve(
        [
          "foundry_list_scenes",
          "foundry_roll_dice",
          "foundry_preflight_transaction",
          "foundry_execute_transaction",
        ].map((name) => ({ name, inputSchema: { type: "object" } })),
      ),
    callTool: async (request) => {
      calls.push(request);
      if (request.name === "foundry_list_scenes") return [{ _id: active, active: true }];
      if (request.name === "foundry_preflight_transaction")
        return { valid: true, transactionId: object(request.arguments)["correlationId"]! };
      return effect(request.name, request.arguments);
    },
  };
  const authorize = async () => {
    await Promise.resolve();
    if (!authorized) throw new Error("revoked");
  };
  const service = new ChatKitNativeActions(client, db, authorize, timeout, () => clock);
  return {
    service,
    db,
    calls,
    client,
    authorize,
    revoke: () => {
      authorized = false;
    },
    scene: (value: string) => {
      active = value;
    },
    expire: () => {
      clock += 400_000;
    },
    effect: (value: typeof effect) => {
      effect = value;
    },
  };
}
const propose = (f: ReturnType<typeof fixture>, actionId = "note") =>
  f.service.request(
    identity,
    scope,
    "native_propose_note",
    { actionId, title: "Session <note>", text: "A door was observed. <script>bad()</script>" },
    signal(),
  );
const decide = (f: ReturnType<typeof fixture>, choice = "approve") =>
  f.service.browser(identity, { threadId: "thread", actionId: "note", decision: choice }, signal());

void it("provider-mocked native roll returns real fixture receipt; repeated delivery and concurrent calls evaluate once", async () => {
  const f = fixture();
  const input = { actionId: "roll", formula: "1d6+3" };
  const results = await Promise.all(
    [1, 2, 3].map(() => f.service.request(identity, scope, "native_roll", input, signal())),
  );
  assert.equal(f.calls.filter((call) => call.name === "foundry_roll_dice").length, 1);
  assert.equal(object(results[0]!)["status"], "completed");
  assert.equal(object(object(results[0]!)["receipt"]!)["total"], 7);
  assert.equal(
    object(await f.service.request(identity, scope, "native_roll", input, signal()))["status"],
    "completed",
  );
  await assert.rejects(
    f.service.request(identity, scope, "native_roll", { ...input, formula: "1d20" }, signal()),
  );
  f.db.close();
});
void it("provider-mocked proposal preflights only; exact confirmed transaction creates one private escaped session note", async () => {
  const f = fixture();
  assert.equal(object(await propose(f))["status"], "pending");
  assert.equal(f.calls.filter((call) => call.name === "foundry_execute_transaction").length, 0);
  const result = await decide(f);
  assert.equal(object(result)["status"], "completed");
  await decide(f);
  await decide(f, "reject");
  const executions = f.calls.filter((call) => call.name === "foundry_execute_transaction");
  assert.equal(executions.length, 1);
  const manifest = object(executions[0]!.arguments);
  const operation = object((manifest["operations"] as AiDmJsonValue[])[0]!);
  assert.equal(operation["documentType"], "JournalEntry");
  assert.equal(operation["kind"], "document.create");
  const data = object(operation["data"]!);
  assert.equal(typeof data["_id"], "string");
  assert.match(data["_id"] as string, /^[a-f0-9]{16}$/);
  assert.deepEqual(data["ownership"], { default: 0 });
  assert.ok(JSON.stringify(data).includes("&lt;script&gt;"));
  assert.equal(manifest["worldId"], "world");
  assert.equal(manifest["idempotencyKey"], manifest["correlationId"]);
  f.db.close();
});
void it("provider-mocked rejected, stale, expired, revoked, wrong-thread/world, arbitrary and malformed actions have no effects", async () => {
  for (const mode of ["reject", "stale", "expired", "revoked", "thread", "world"]) {
    const f = fixture();
    await propose(f);
    if (mode === "reject") await decide(f, "reject");
    else {
      if (mode === "stale") f.scene("other");
      if (mode === "expired") f.expire();
      if (mode === "revoked") f.revoke();
      await assert.rejects(
        f.service.browser(
          mode === "world" ? { ...identity, worldId: "other" } : identity,
          {
            threadId: mode === "thread" ? "other" : "thread",
            actionId: "note",
            decision: "approve",
          },
          signal(),
        ),
      );
    }
    assert.equal(f.calls.filter((call) => call.name === "foundry_execute_transaction").length, 0);
    f.db.close();
  }
  const f = fixture();
  for (const args of [
    { actionId: "x", formula: "100d20" },
    { actionId: "x", formula: "1d20;bad" },
    { actionId: "x", formula: "1d20", shell: "bad" },
  ])
    await assert.rejects(f.service.request(identity, scope, "native_roll", args, signal()));
  await assert.rejects(f.service.request(identity, scope, "native_update_actor", {}, signal()));
  await assert.rejects(
    f.service.request(
      identity,
      { ...scope, worldId: "other" },
      "native_roll",
      { actionId: "x", formula: "1d20" },
      signal(),
    ),
  );
  assert.equal(f.calls.length, 0);
  f.db.close();
});
void it("provider-mocked uncertain timeout, disconnect, malformed receipt and restart never blindly repeat effects", async () => {
  for (const mode of ["timeout", "disconnect", "receipt"]) {
    const f = fixture(30);
    await propose(f);
    const abort = new AbortController();
    f.effect(async () => {
      if (mode === "receipt") return { committed: false };
      if (mode === "disconnect") abort.abort();
      return new Promise(() => {});
    });
    const pending = f.service.browser(
      identity,
      { threadId: "thread", actionId: "note", decision: "approve" },
      abort.signal,
    );
    // Timeout timers are unref'ed; keep the test process alive while verifying hard bounds.
    const keepalive = setTimeout(() => {}, 100);
    assert.equal(object(await pending)["status"], "uncertain");
    clearTimeout(keepalive);
    const restarted = new ChatKitNativeActions(f.client, f.db, f.authorize);
    assert.equal(
      object(
        await restarted.browser(
          identity,
          { threadId: "thread", actionId: "note", decision: "approve" },
          signal(),
        ),
      )["status"],
      "uncertain",
    );
    assert.equal(f.calls.filter((call) => call.name === "foundry_execute_transaction").length, 1);
    f.db.close();
  }
});
void it("provider-mocked cancellation before approval dispatch leaves pending and no effect", async () => {
  const f = fixture();
  await propose(f);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.service.browser(
      identity,
      { threadId: "thread", actionId: "note", decision: "approve" },
      abort.signal,
    ),
  );
  assert.equal(f.calls.filter((call) => call.name === "foundry_execute_transaction").length, 0);
  f.db.close();
});
void it("provider-mocked wrong formula, empty/wrong dice, impossible values and false total become uncertain without reroll", async () => {
  for (const receipt of [
    { formula: "99d100", total: 9900, result: "9900", dice: [] },
    { formula: "1d6", total: 4, result: "4", dice: [] },
    { formula: "1d6", total: 4, result: "4", dice: [{ faces: 20, results: [4] }] },
    { formula: "1d6", total: 7, result: "7", dice: [{ faces: 6, results: [7] }] },
    { formula: "1d6", total: 4, result: "4", dice: [{ faces: 6, results: [2, 2] }] },
    { formula: "1d6", total: 99, result: "99", dice: [{ faces: 6, results: [4] }] },
    { formula: "1d6", total: 4, result: "99", dice: [{ faces: 6, results: [4] }] },
    { formula: "1d6", total: 4, result: "100-96", dice: [{ faces: 6, results: [4] }] },
    { formula: "1d6", total: 4, result: "4;process.exit()", dice: [{ faces: 6, results: [4] }] },
    { formula: "1d6", total: 4, result: "4*1", dice: [{ faces: 6, results: [4] }] },
  ]) {
    const f = fixture();
    f.effect(() => Promise.resolve(receipt));
    const args = { actionId: "receipt-probe", formula: "1d6" };
    const value = object(await f.service.request(identity, scope, "native_roll", args, signal()));
    assert.equal(value["status"], "uncertain");
    assert.equal(value["receipt"], null);
    await f.service.request(identity, scope, "native_roll", args, signal());
    assert.equal(f.calls.filter((call) => call.name === "foundry_roll_dice").length, 1);
    f.db.close();
  }
  const f = fixture();
  f.effect(() =>
    Promise.resolve({
      formula: "2d6 - 2",
      total: 8,
      result: "10 - 2",
      dice: [{ faces: 6, results: [4, 6] }],
    }),
  );
  assert.equal(
    object(
      await f.service.request(
        identity,
        scope,
        "native_roll",
        { actionId: "valid", formula: "2d6-2" },
        signal(),
      ),
    )["status"],
    "completed",
  );
  f.db.close();
});
void it("provider-mocked native resolved individual dice and parentheses expressions are accepted", async () => {
  for (const expression of ["(4 + 2)", "((4) + (2))", "6"]) {
    const f = fixture();
    f.effect(() =>
      Promise.resolve({
        formula: "2d6",
        total: 6,
        result: expression,
        dice: [{ faces: 6, results: [4, 2] }],
      }),
    );
    assert.equal(
      object(
        await f.service.request(
          identity,
          scope,
          "native_roll",
          { actionId: "actual-native", formula: "2d6" },
          signal(),
        ),
      )["status"],
      "completed",
    );
    f.db.close();
  }
  const f = fixture();
  f.effect(() =>
    Promise.resolve({
      formula: "2d6 - 2",
      total: 4,
      result: "(4 + 2) - 2",
      dice: [{ faces: 6, results: [4, 2] }],
    }),
  );
  assert.equal(
    object(
      await f.service.request(
        identity,
        scope,
        "native_roll",
        { actionId: "modified-native", formula: "2d6-2" },
        signal(),
      ),
    )["status"],
    "completed",
  );
  f.db.close();
});
void it("provider-mocked concurrent approvals execute once and persisted receipt survives database reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aidm-native-test-"));
  const path = join(directory, "actions.sqlite");
  const f = fixture(1000, path);
  try {
    await propose(f);
    await Promise.all([decide(f), decide(f), decide(f)]);
    assert.equal(f.calls.filter((call) => call.name === "foundry_execute_transaction").length, 1);
    f.db.close();
    const reopened = new DatabaseSync(path);
    try {
      const service = new ChatKitNativeActions(f.client, reopened, f.authorize);
      const result = await service.browser(
        identity,
        { threadId: "thread", actionId: "note", decision: "approve" },
        signal(),
      );
      assert.equal(object(result)["status"], "completed");
      assert.equal(f.calls.filter((call) => call.name === "foundry_execute_transaction").length, 1);
      assert.equal((service.recent({ ...scope, threadId: "other" }) as AiDmJsonValue[]).length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
