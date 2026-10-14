import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ChatKitToolAudit } from "./tool-audit.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { createAiDmApp } from "../app.js";
import { ChatKitReadTools } from "./read-tools.js";
import type { TrustedToolCatalog } from "../tool-catalog/index.js";
const scope = { worldId: "w", userId: "gm", threadId: "t" };
const base = {
  ...scope,
  runCorrelation: "correlation",
  operation: "tool_search",
  arguments: { query: "pause", limit: 8 },
  outcome: "returned" as const,
};
void it("persists bounded sanitized search/load/execute evidence and digest-only grant mapping", () => {
  const db = new DatabaseSync(":memory:");
  const audit = new ChatKitToolAudit(db);
  audit.observe({
    ...base,
    result: {
      ok: true,
      value: {
        descriptors: [{ toolId: "foundry_get_game_paused", inputSchema: { private: "secret" } }],
      },
    },
  });
  audit.observe({
    ...base,
    operation: "tool_load",
    arguments: { toolId: "ai_dm_set_game_paused" },
    result: {
      ok: true,
      value: {
        definition: {
          toolId: "ai_dm_set_game_paused",
          schemaDigest: "a".repeat(64),
          inputSchema: { secret: "secret" },
        },
        grant: { grantId: "raw-grant" },
      },
    },
  });
  audit.observe({
    ...base,
    operation: "tool_execute",
    arguments: {
      grantId: "raw-grant",
      effect: "present",
      arguments: { actionId: "action1", text: "private GM secret" },
    },
    result: {
      ok: true,
      value: {
        result: {
          status: "completed",
          receipt: { readBack: { paused: false } },
          private: "secret",
        },
      },
    },
  });
  const rows = audit.list(scope) as Record<string, unknown>[];
  assert.equal(rows.length, 3);
  assert.equal(rows[2]!["toolId"], "ai_dm_set_game_paused");
  assert.equal(rows[2]!["readBackPaused"], false);
  const encoded = JSON.stringify(rows);
  assert.ok(!encoded.includes("raw-grant"));
  assert.ok(!encoded.includes("secret"));
  assert.deepEqual(audit.list({ ...scope, worldId: "other" }), []);
  assert.deepEqual(audit.list({ ...scope, userId: "other" }), []);
  assert.equal(audit.list(scope, Number(rows[0]!["sequence"]), 1).length, 1);
  db.close();
});
void it("records attempts, denial, cancellation and uncertain separately and bounds retention", () => {
  const db = new DatabaseSync(":memory:");
  const audit = new ChatKitToolAudit(db, 3);
  for (const outcome of ["attempt", "error", "cancelled"] as const)
    audit.observe({ ...base, outcome });
  audit.observe({
    ...base,
    result: { ok: false, denial: { code: "TOOL_UNAUTHORIZED", message: "secret" } },
  });
  audit.observe({ ...base, result: { ok: true, value: { result: { status: "uncertain" } } } });
  const rows = audit.list(scope) as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((r) => r["outcome"]),
    ["cancelled", "denied", "uncertain"],
  );
  assert.equal(rows[1]!["denialCode"], "TOOL_UNAUTHORIZED");
  assert.throws(() => audit.list(scope, 0, 101));
  db.close();
});
void it("does not retain non-discovery data or credential-shaped queries", () => {
  const db = new DatabaseSync(":memory:");
  const audit = new ChatKitToolAudit(db);
  audit.observe({ ...base, operation: "campaign_read", result: { private: "secret" } });
  audit.observe({
    ...base,
    arguments: { query: "pause Bearer some-secret https://secret.example sk-secretlongvalue" },
  });
  const rows = audit.list(scope);
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes("some-secret"));
  assert.ok(!JSON.stringify(rows).includes("secret.example"));
  db.close();
});
void it("survives SQLite restart and captures actual semantic verified pause receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "tool-audit-"));
  const path = join(dir, "audit.sqlite");
  try {
    const db = new DatabaseSync(path);
    new ChatKitToolAudit(db).observe({
      ...base,
      operation: "tool_execute",
      arguments: { effect: "present", arguments: { actionId: "pause1" } },
      result: {
        ok: true,
        value: {
          result: {
            status: "completed",
            receipt: { paused: false, verifiedBy: "foundry_get_game_paused" },
          },
        },
      },
    });
    db.close();
    const reopened = new DatabaseSync(path);
    const rows = new ChatKitToolAudit(reopened).list(scope) as Record<string, unknown>[];
    assert.equal(rows[0]!["readBackPaused"], false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
void it("authenticated handler excludes spoofed scopes and observer failure preserves completed response", async () => {
  let observes = 0;
  let executions = 0;
  const adapter = new ChatKitReadTools(
    { listTools: () => Promise.resolve([]), callTool: () => Promise.resolve(null) },
    () => Promise.resolve(),
    {} as TrustedToolCatalog,
    {
      internalSecret: "internal",
      toolAudit: () => {
        observes++;
        throw new Error("audit unavailable");
      },
    },
  );
  adapter.execute = () => {
    executions++;
    return Promise.resolve({ ok: true, value: { result: { status: "completed" } } });
  };
  const run = adapter.begin(
    { clientId: "client", worldId: "w", userId: "gm", lane: "gm", isGm: true },
    { params: { thread_id: "t" } },
    new AbortController().signal,
  );
  const app = createAiDmApp({
    readiness: () => ({ ready: true, details: {} }),
    chatkitReadHandler: adapter.handler,
  });
  const send = (secret: string, world = "w") =>
    request(app)
      .post("/internal/chatkit/read")
      .set({
        "x-chatkit-secret": secret,
        "x-chatkit-world": world,
        "x-chatkit-user": "gm",
        "x-chatkit-thread": "t",
        "x-chatkit-read-run": run.token,
      })
      .send({ operation: "tool_execute", arguments: {} });
  assert.equal((await send("wrong")).status, 403);
  assert.equal(observes, 0);
  assert.equal(executions, 0);
  assert.equal((await send("internal", "spoofed")).status, 200);
  assert.equal(observes, 0);
  assert.equal(
    ((await send("internal")).body as { result: { value: { result: { status: string } } } }).result
      .value.result.status,
    "completed",
  );
  assert.equal(observes, 2);
  assert.equal(executions, 2);
  run.release();
});
