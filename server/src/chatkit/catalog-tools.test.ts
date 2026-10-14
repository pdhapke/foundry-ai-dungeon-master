import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { ChatKitReadTools } from "./read-tools.js";
import { ChatKitNativeActions } from "./native-actions.js";
import {
  CHATKIT_READ_TOOL_METADATA,
  FoundryLocalApiProviderAdapter,
  TrustedToolCatalog,
  type FoundryLocalApiMcpClient,
} from "../tool-catalog/index.js";

const identity: AiDmAuthenticatedIdentity = {
  clientId: "client",
  worldId: "world",
  userId: "gm",
  lane: "gm",
  isGm: true,
};
const scope = { worldId: "world", userId: "gm", threadId: "thread" };
const object = (value: AiDmJsonValue) => value as Record<string, AiDmJsonValue>;
function fixture() {
  let revoked = false;
  let drift = false;
  let uncertain = false;
  let hold = false;
  let stale = false;
  const calls: string[] = [];
  const db = new DatabaseSync(":memory:");
  const client: FoundryLocalApiMcpClient = {
    listTools: () =>
      Promise.resolve([
        ...CHATKIT_READ_TOOL_METADATA.map((tool) => ({
          name: tool.toolId,
          inputSchema: {
            type: "object",
            properties:
              tool.toolId === "foundry_get_actor" || tool.toolId === "foundry_get_scene"
                ? { id: { type: "string" } }
                : {},
            additionalProperties: false,
          },
        })),
        ...[
          "foundry_roll_dice",
          "foundry_preflight_transaction",
          "foundry_execute_transaction",
          "unknown_raw_mutation",
        ].map((name) => ({
          name,
          inputSchema: {
            type: "object",
            description: drift && name === "foundry_roll_dice" ? "changed schema" : "fixture",
          },
        })),
      ]),
    callTool: async ({ name, arguments: input }) => {
      calls.push(name);
      if (hold) return new Promise(() => {});
      if (name === "foundry_list_scenes") return [{ _id: "scene", active: true }];
      if (name === "foundry_get_scene")
        return {
          _id: "scene",
          active: true,
          tokens: [
            { _id: "hero-token", actorId: "hero", hidden: false },
            { _id: "secret-token", actorId: "secret", hidden: true, name: "secret-password" },
          ],
          private: "secret-password",
        };
      if (name === "foundry_get_actor")
        return {
          _id: object(input)["id"]!,
          name: "Hero",
          type: "character",
          secret: "secret-password",
        };
      if (name === "foundry_preflight_transaction")
        return { valid: !stale, transactionId: object(input)["correlationId"]! };
      if (name === "foundry_roll_dice") {
        if (uncertain) throw new Error("transport disconnected after dispatch");
        return {
          formula: object(input)["formula"]!,
          total: 7,
          result: "4 + 3",
          dice: [{ faces: 6, results: [4] }],
        };
      }
      if (name === "foundry_execute_transaction") {
        const operation = object((object(input)["operations"] as AiDmJsonValue[])[0]!);
        return {
          transactionId: object(input)["correlationId"]!,
          idempotencyKey: object(input)["idempotencyKey"]!,
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
      }
      throw new Error("Unexpected MCP call");
    },
  };
  const authorize = async () => {
    await Promise.resolve();
    if (revoked) throw new Error("revoked");
  };
  const actions = new ChatKitNativeActions(client, db, authorize, 50);
  const catalog = new TrustedToolCatalog(
    new FoundryLocalApiProviderAdapter({ client, providerVersion: "fixture" }),
    CHATKIT_READ_TOOL_METADATA,
    "fixture",
  );
  const adapter = new ChatKitReadTools(client, authorize, catalog, {
    internalSecret: "internal",
    actions,
    timeoutMs: 50,
  });
  const controller = new AbortController();
  const run = adapter.begin(identity, { params: { thread_id: "thread" } }, controller.signal);
  const execute = (operation: string, args: unknown, token = run.token, target = scope) =>
    adapter.execute(token, target, operation, args, new AbortController().signal);
  const discover = async (query: string, toolId: string) => {
    const found = object(await execute("tool_search", { query, limit: 8 }));
    assert.equal(found["ok"], true);
    const loaded = object(
      await execute("tool_load", { searchId: object(found["value"]!)["searchId"], toolId }),
    );
    assert.equal(loaded["ok"], true);
    return object(object(loaded["value"]!)["grant"]!)["grantId"]!;
  };
  return {
    adapter,
    execute,
    discover,
    calls,
    actions,
    run,
    controller,
    db,
    revoke: () => {
      revoked = true;
    },
    drift: () => {
      drift = true;
    },
    uncertain: () => {
      uncertain = true;
    },
    hold: () => {
      hold = true;
    },
    stale: () => {
      stale = true;
    },
  };
}

void it("discovers loaded semantic dice through adapter/catalog/durable native MCP, replays exact input and refuses conflict", async () => {
  const f = fixture();
  try {
    const grantId = await f.discover("dice roll", "ai_dm_roll_dice");
    const request = {
      grantId,
      effect: "present",
      arguments: { actionId: "dice", formula: "1d6+3" },
    };
    const result = await f.execute("tool_execute", request);
    assert.match(JSON.stringify(result), /"status":"completed"/);
    assert.match(JSON.stringify(await f.execute("tool_execute", request)), /"status":"completed"/);
    assert.equal(f.calls.filter((name) => name === "foundry_roll_dice").length, 1);
    const conflict = await f.execute("tool_execute", {
      ...request,
      arguments: { actionId: "dice", formula: "1d6" },
    });
    assert.equal(object(conflict)["ok"], false);
    assert.match(JSON.stringify(conflict), /"retryable":false/);
  } finally {
    f.db.close();
  }
});
void it("discoverable private note is a durable proposal, no mutation before separate human approval", async () => {
  const f = fixture();
  try {
    const grantId = await f.discover("private journal note", "ai_dm_propose_private_note");
    const result = await f.execute("tool_execute", {
      grantId,
      effect: "propose",
      arguments: { actionId: "note", title: "Session", text: "Approved observation" },
    });
    assert.match(JSON.stringify(result), /"status":"pending"/);
    assert.equal(f.calls.includes("foundry_execute_transaction"), false);
    const approved = await f.actions.browser(
      identity,
      { threadId: "thread", actionId: "note", decision: "approve" },
      new AbortController().signal,
    );
    assert.match(JSON.stringify(approved), /"status":"completed"/);
    assert.equal(f.calls.filter((name) => name === "foundry_execute_transaction").length, 1);
  } finally {
    f.db.close();
  }
});
void it("projects authorized reads without hidden tokens/secrets; unknown tools and commit bypass stay unavailable", async () => {
  const f = fixture();
  try {
    const grantId = await f.discover("scene", "foundry_get_scene");
    const result = await f.execute("tool_execute", {
      grantId,
      effect: "read",
      arguments: { id: "scene" },
    });
    assert.doesNotMatch(JSON.stringify(result), /secret-password|secret-token/);
    assert.match(JSON.stringify(result), /hero-token/);
    await assert.rejects(f.execute("tool_execute", { grantId, effect: "commit", arguments: {} }));
    const unknown = await f.execute("tool_load", {
      searchId: "search:invented",
      toolId: "unknown_raw_mutation",
    });
    assert.equal(object(unknown)["ok"], false);
    const outside = await f.execute("tool_execute", {
      grantId,
      effect: "read",
      arguments: { id: "other" },
    });
    assert.equal(object(outside)["ok"], false);
    assert.equal(f.calls.includes("unknown_raw_mutation"), false);
  } finally {
    f.db.close();
  }
});
void it("underlying MCP schema drift invalidates semantic grant; revoked or released capabilities cannot execute", async () => {
  const f = fixture();
  try {
    const grantId = await f.discover("dice", "ai_dm_roll_dice");
    f.drift();
    const stale = await f.execute("tool_execute", {
      grantId,
      effect: "present",
      arguments: { actionId: "a", formula: "1d6+3" },
    });
    assert.match(JSON.stringify(stale), /TOOL_CATALOG_STALE/);
    assert.equal(f.calls.includes("foundry_roll_dice"), false);
    f.revoke();
    await assert.rejects(f.execute("tool_search", { query: "dice", limit: 4 }));
    f.run.release();
    await assert.rejects(f.execute("tool_load", { searchId: "s", toolId: "a" }));
  } finally {
    f.db.close();
  }
});
void it("uncertain durable dice receipt never redispatches; wrong scope and schema arguments deny before mutation", async () => {
  const f = fixture();
  try {
    const grantId = await f.discover("dice", "ai_dm_roll_dice");
    f.uncertain();
    const request = { grantId, effect: "present", arguments: { actionId: "a", formula: "1d6+3" } };
    assert.match(JSON.stringify(await f.execute("tool_execute", request)), /"status":"uncertain"/);
    assert.match(JSON.stringify(await f.execute("tool_execute", request)), /"status":"uncertain"/);
    assert.equal(f.calls.filter((name) => name === "foundry_roll_dice").length, 1);
    await assert.rejects(
      f.execute("tool_execute", request, f.run.token, { ...scope, worldId: "other" }),
    );
    const invalid = await f.execute("tool_execute", {
      ...request,
      arguments: { ...request.arguments, data: { secret: true } },
    });
    assert.match(JSON.stringify(invalid), /TOOL_ARGUMENT_INVALID/);
  } finally {
    f.db.close();
  }
});
void it("response cancellation interrupts noncooperative discovery action and forbids response replay", async () => {
  const f = fixture();
  try {
    const grantId = await f.discover("dice", "ai_dm_roll_dice");
    f.hold();
    const work = f.execute("tool_execute", {
      grantId,
      effect: "present",
      arguments: { actionId: "a", formula: "1d6+3" },
    });
    setTimeout(() => f.controller.abort(), 5);
    await assert.rejects(work);
    await assert.rejects(f.execute("tool_search", { query: "dice", limit: 4 }));
  } finally {
    f.db.close();
  }
});
void it("real Python wrapper HTTP contract reaches adapter catalog and controlled MCP without a model", async () => {
  const f = fixture();
  const app = express();
  app.use(express.json());
  app.post("/internal/chatkit/read", f.adapter.handler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const python = fileURLToPath(
      new URL(
        process.platform === "win32"
          ? "../../../chatkit-server/.venv/Scripts/python.exe"
          : "../../../chatkit-server/.venv/bin/python",
        import.meta.url,
      ),
    );
    const script = fileURLToPath(
      new URL("../../../chatkit-server/discovery_contract_probe.py", import.meta.url),
    );
    const child = spawn(python, [script], {
      windowsHide: true,
      env: {
        ...process.env,
        AI_DM_CHATKIT_READ_URL: `http://127.0.0.1:${address.port}/internal/chatkit/read`,
        CONTRACT_READ_TOKEN: f.run.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, output);
    assert.match(output, /controlled-MCP PASS/);
    assert.equal(f.calls.filter((name) => name === "foundry_roll_dice").length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.db.close();
  }
});
void it("strict effect/budget boundaries and stale private-note preflight block every game mutation", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.execute("tool_search", { query: "dice", limit: 9 }));
    const grantId = await f.discover("private journal note", "ai_dm_propose_private_note");
    const unauthorized = await f.execute("tool_execute", {
      grantId,
      effect: "present",
      arguments: { actionId: "n", title: "Note", text: "Fact" },
    });
    assert.match(JSON.stringify(unauthorized), /TOOL_UNAUTHORIZED/);
    await assert.rejects(
      f.execute("tool_execute", {
        grantId,
        effect: "propose",
        arguments: {},
        commitAuthorization: { authorizationId: "invented" },
      }),
    );
    f.stale();
    const stale = await f.execute("tool_execute", {
      grantId,
      effect: "propose",
      arguments: { actionId: "n", title: "Note", text: "Fact" },
    });
    assert.equal(object(stale)["ok"], false);
    assert.equal(f.calls.includes("foundry_execute_transaction"), false);
    for (let i = 0; i < 3; i++) await f.execute("tool_search", { query: "scene", limit: 4 });
    const exhausted = await f.execute("tool_search", { query: "dice", limit: 4 });
    assert.match(JSON.stringify(exhausted), /TOOL_BUDGET_EXCEEDED/);
  } finally {
    f.db.close();
  }
});
