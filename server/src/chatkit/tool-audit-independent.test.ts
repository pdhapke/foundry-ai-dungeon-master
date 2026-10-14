import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { createAiDmApp } from "../app.js";
import { ChatKitReadTools } from "./read-tools.js";
import { ChatKitNativeActions } from "./native-actions.js";
import { ChatKitToolAudit } from "./tool-audit.js";
import {
  CHATKIT_READ_TOOL_METADATA,
  FoundryLocalApiProviderAdapter,
  TrustedToolCatalog,
} from "../tool-catalog/index.js";
const scope = { worldId: "w", userId: "gm", threadId: "t" };
void it("independent authenticated discovery/load/execution audit tracks only bound scope and cannot duplicate provider calls", async () => {
  const db = new DatabaseSync(":memory:");
  const audit = new ChatKitToolAudit(db);
  let providerCalls = 0;
  const client = {
    listTools: () =>
      Promise.resolve([
        {
          name: "foundry_get_game_paused",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ]),
    callTool: () => {
      providerCalls++;
      return Promise.resolve({ paused: false });
    },
  };
  const adapter = new ChatKitReadTools(
    client,
    async () => {},
    new TrustedToolCatalog(
      new FoundryLocalApiProviderAdapter({ client, providerVersion: "independent-fixture" }),
      CHATKIT_READ_TOOL_METADATA,
      "independent",
    ),
    {
      internalSecret: "internal",
      toolAudit: (event) => {
        audit.observe(event);
        throw new Error("Evidence observer unavailable after persistence");
      },
      actions: new ChatKitNativeActions(client, db, async () => {}),
    },
  );
  const run = adapter.begin(
    { clientId: "c", worldId: "w", userId: "gm", lane: "gm", isGm: true },
    { params: { thread_id: "t" } },
    new AbortController().signal,
  );
  const app = createAiDmApp({
    readiness: () => ({ ready: true, details: {} }),
    chatkitReadHandler: adapter.handler,
  });
  const send = (operation: string, args: unknown, world = "w") =>
    request(app)
      .post("/internal/chatkit/read")
      .set({
        "x-chatkit-secret": "internal",
        "x-chatkit-world": world,
        "x-chatkit-user": "gm",
        "x-chatkit-thread": "t",
        "x-chatkit-read-run": run.token,
      })
      .send({ operation, arguments: args });
  assert.equal((await send("tool_search", { query: "game", limit: 8 }, "wrong")).status, 403);
  assert.equal(audit.list(scope).length, 0);
  const searched = (
    (await send("tool_search", { query: "game", limit: 8 })).body as {
      result: { value: { searchId: string; descriptors: { toolId: string }[] } };
    }
  ).result.value;
  assert.ok(
    searched.descriptors.some((d: { toolId: string }) => d.toolId === "foundry_get_game_paused"),
  );
  const loaded = (
    await send("tool_load", { searchId: searched.searchId, toolId: "foundry_get_game_paused" })
  ).body as { result: { value: { grant: { grantId: string } } } };
  const executed = await send("tool_execute", {
    grantId: loaded.result.value.grant.grantId,
    effect: "read",
    arguments: {},
  });
  assert.equal(executed.status, 200);
  assert.equal((executed.body as { result: { ok: boolean } }).result.ok, true);
  assert.equal(providerCalls, 1);
  const denied = await send("tool_execute", { grantId: "missing", effect: "read", arguments: {} });
  assert.equal((denied.body as { result: { ok: boolean } }).result.ok, false);
  const rows = audit.list(scope) as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((r) => r["outcome"]),
    ["attempt", "returned", "attempt", "returned", "attempt", "returned", "attempt", "denied"],
  );
  assert.equal(rows[5]!["toolId"], "foundry_get_game_paused");
  assert.equal(rows[5]!["paused"], false);
  assert.ok(!JSON.stringify(rows).includes(loaded.result.value.grant.grantId));
  assert.deepEqual(audit.list({ ...scope, threadId: "other" }), []);
  run.release();
  db.close();
});
void it("independent authenticated handler identifies cancellation of the issued run", async () => {
  const db = new DatabaseSync(":memory:");
  const audit = new ChatKitToolAudit(db);
  const client = { listTools: () => Promise.resolve([]), callTool: () => Promise.resolve(null) };
  const adapter = new ChatKitReadTools(
    client,
    async () => {},
    new TrustedToolCatalog(
      new FoundryLocalApiProviderAdapter({ client, providerVersion: "independent-fixture" }),
      CHATKIT_READ_TOOL_METADATA,
      "independent",
    ),
    { internalSecret: "internal", toolAudit: audit.observe },
  );
  const controller = new AbortController();
  const run = adapter.begin(
    { clientId: "c", worldId: "w", userId: "gm", lane: "gm", isGm: true },
    { params: { thread_id: "t" } },
    controller.signal,
  );
  controller.abort(new Error("User cancelled"));
  const app = createAiDmApp({
    readiness: () => ({ ready: true, details: {} }),
    chatkitReadHandler: adapter.handler,
  });
  await request(app)
    .post("/internal/chatkit/read")
    .set({
      "x-chatkit-secret": "internal",
      "x-chatkit-world": "w",
      "x-chatkit-user": "gm",
      "x-chatkit-thread": "t",
      "x-chatkit-read-run": run.token,
    })
    .send({ operation: "tool_search", arguments: { query: "pause", limit: 8 } });
  assert.deepEqual(
    (audit.list(scope) as Record<string, unknown>[]).map((row) => row["outcome"]),
    ["attempt", "cancelled"],
  );
  run.release();
  db.close();
});
void it("independent audit rejects credential-shaped identifiers and redacts key-value credentials", () => {
  const db = new DatabaseSync(":memory:");
  const audit = new ChatKitToolAudit(db);
  audit.observe({
    ...scope,
    runCorrelation: "run",
    operation: "tool_search",
    outcome: "attempt",
    arguments: { query: "pause api_key=short-secret password=local-pass" },
  });
  audit.observe({
    ...scope,
    runCorrelation: "run",
    operation: "tool_load",
    outcome: "attempt",
    arguments: { toolId: "sk-secretlongvalue" },
  });
  audit.observe({
    ...scope,
    runCorrelation: "run",
    operation: "tool_execute",
    outcome: "attempt",
    arguments: { effect: "present", arguments: { actionId: "sk-hiddenactionkey" } },
  });
  const serialized = JSON.stringify(audit.list(scope));
  assert.ok(!serialized.includes("short-secret"));
  assert.ok(!serialized.includes("local-pass"));
  assert.ok(!serialized.includes("sk-secretlongvalue"));
  assert.ok(!serialized.includes("sk-hiddenactionkey"));
  db.close();
});
