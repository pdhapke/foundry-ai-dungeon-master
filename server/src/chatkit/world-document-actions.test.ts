import assert from "node:assert/strict";
import test from "node:test";
import { ChatKitReadTools } from "./read-tools.js";
import { ChatKitNativeActions } from "./native-actions.js";
import {
  TrustedToolCatalog,
  FoundryLocalApiProviderAdapter,
  CHATKIT_READ_TOOL_METADATA,
} from "../tool-catalog/index.js";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import {
  ChatKitWorldDocumentActions,
  worldSourceRevision,
  worldCanonicalJson,
} from "./world-document-actions.js";
const identity: AiDmAuthenticatedIdentity = {
  clientId: "fixture",
  worldId: "world",
  userId: "gm",
  isGm: true,
  lane: "gm",
};
const scope = { worldId: "world", userId: "gm", threadId: "thread" };
const authority = { worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) } };
const obj = (v: AiDmJsonValue) => v as Record<string, AiDmJsonValue>;
function fixture() {
  const db = new DatabaseSync(":memory:");
  let source: AiDmJsonValue = {
    _id: "actor",
    name: "Offscene NPC",
    system: { hp: 10 },
    password: "secret",
  };
  let revoked = false,
    wrongParent = false,
    uncertain = false,
    drift = false;
  let applies = 0;
  const client: FoundryLocalApiMcpClient = {
    listTools: () =>
      Promise.resolve(
        [
          "foundry_get_actor",
          "foundry_update_actor",
          "foundry_delete_actor",
          "foundry_get_actor_item",
          "foundry_get_world_document",
          "foundry_apply_world_document",
        ].map((name) => ({
          name,
          inputSchema: { type: "object", description: drift ? "drift" : "fixture" },
        })),
      ),
    callTool: ({ name, arguments: args }) => {
      const a = obj(args);
      const base = {
        worldId: "world",
        family: a["family"]!,
        operation: a["operation"]!,
        targetId: a["targetId"]!,
        ...(a["parentId"] ? { parentId: wrongParent ? "other" : a["parentId"] } : {}),
      };
      if (name === "foundry_apply_world_document") {
        applies++;
        if (uncertain) return Promise.reject(new Error("transport lost"));
        if (a["operation"] === "delete") source = null;
        else source = { ...obj(source), ...obj(a["data"]!) };
        return Promise.resolve({
          ...base,
          source,
          revision: worldSourceRevision(source),
          correlationId: a["correlationId"]!,
          idempotencyKey: a["idempotencyKey"]!,
          verified: true,
        });
      }
      return Promise.resolve({ ...base, source, revision: worldSourceRevision(source) });
    },
  };
  const service = new ChatKitWorldDocumentActions(client, db, () =>
    revoked ? Promise.reject(new Error("revoked")) : Promise.resolve(),
  );
  return {
    service,
    client,
    db,
    largeSource() {
      source = { ...obj(source), description: "x".repeat(14000) };
    },
    get source() {
      return source;
    },
    get applies() {
      return applies;
    },
    revoke() {
      revoked = true;
    },
    wrongParent() {
      wrongParent = true;
    },
    uncertain() {
      uncertain = true;
    },
    drift() {
      drift = true;
    },
  };
}
void test("world GM offscene read is bounded untrusted and secrets removed, no snapshot-party ceiling", async () => {
  const f = fixture();
  try {
    const result = obj(
      await f.service.request(
        identity,
        scope,
        "read",
        { toolId: "foundry_get_actor", args: { id: "actor" } },
        undefined,
        new AbortController().signal,
      ),
    );
    assert.equal(obj(result["source"]!)["password"], undefined);
    assert.equal(result["narrationAllowed"], false);
    assert.equal(f.applies, 0);
    assert.equal(result["revision"], worldSourceRevision(f.source));
  } finally {
    f.db.close();
  }
});
void test("GM manual request update completes independent readback and duplicate is not dispatched", async () => {
  const f = fixture();
  try {
    const raw = {
      toolId: "foundry_update_actor",
      args: { id: "actor", changes: { name: "Prepared NPC" } },
      actionId: "update",
      expectedRevision: worldSourceRevision(f.source),
    };
    await assert.rejects(
      f.service.request(identity, scope, "write", raw, undefined, new AbortController().signal),
    );
    const result = obj(
      await f.service.request(
        identity,
        scope,
        "write",
        raw,
        authority,
        new AbortController().signal,
      ),
    );
    assert.equal(result["status"], "completed");
    assert.equal(obj(result["receipt"]!)["verifiedBy"], "foundry_get_world_document");
    assert.equal(
      obj(
        await f.service.request(
          identity,
          scope,
          "write",
          raw,
          authority,
          new AbortController().signal,
        ),
      )["status"],
      "completed",
    );
    assert.equal(f.applies, 1);
    await assert.rejects(
      f.service.request(
        identity,
        { ...scope, worldId: "other" },
        "write",
        raw,
        authority,
        new AbortController().signal,
      ),
    );
  } finally {
    f.db.close();
  }
});
void test("destructive deletion requires exact browser review before verified absence", async () => {
  const f = fixture();
  try {
    const raw = {
      toolId: "foundry_delete_actor",
      args: { id: "actor" },
      actionId: "delete",
      expectedRevision: worldSourceRevision(f.source),
    };
    const pending = obj(
      await f.service.request(
        identity,
        scope,
        "write",
        raw,
        authority,
        new AbortController().signal,
      ),
    );
    assert.equal(pending["status"], "pending");
    assert.equal(f.applies, 0);
    const review = obj(
      await f.service.browser(
        identity,
        { kind: "world", threadId: "thread", actionId: "delete" },
        new AbortController().signal,
      ),
    );
    assert.equal(review["reviewComplete"], true);
    assert.equal(review["reviewDigest"], pending["reviewDigest"]);
    await assert.rejects(
      f.service.browser(
        identity,
        {
          kind: "world",
          threadId: "thread",
          actionId: "delete",
          decision: "approve",
          reviewDigest: "b".repeat(64),
        },
        new AbortController().signal,
      ),
    );
    const completed = obj(
      await f.service.browser(
        identity,
        {
          kind: "world",
          threadId: "thread",
          actionId: "delete",
          decision: "approve",
          reviewDigest: review["reviewDigest"],
        },
        new AbortController().signal,
      ),
    );
    assert.equal(completed["status"], "completed");
    assert.equal(f.source, null);
    assert.equal(f.applies, 1);
  } finally {
    f.db.close();
  }
});
void test("uncertain mutation is not retried; revocation and executable data cannot dispatch", async () => {
  const f = fixture();
  try {
    const raw = {
      toolId: "foundry_update_actor",
      args: { id: "actor", changes: { name: "new" } },
      actionId: "uncertain",
      expectedRevision: worldSourceRevision(f.source),
    };
    f.uncertain();
    assert.equal(
      obj(
        await f.service.request(
          identity,
          scope,
          "write",
          raw,
          authority,
          new AbortController().signal,
        ),
      )["status"],
      "uncertain",
    );
    await f.service.request(identity, scope, "write", raw, authority, new AbortController().signal);
    assert.equal(f.applies, 1);
    await assert.rejects(
      f.service.request(
        identity,
        scope,
        "write",
        {
          ...raw,
          actionId: "code",
          args: { id: "actor", changes: { "flags.dae": { script: "evil" } } },
        },
        authority,
        new AbortController().signal,
      ),
    );
    assert.equal(f.applies, 1);
    f.revoke();
    await assert.rejects(
      f.service.request(
        identity,
        scope,
        "read",
        { toolId: "foundry_get_actor", args: { id: "actor" } },
        undefined,
        new AbortController().signal,
      ),
    );
  } finally {
    f.db.close();
  }
});
void test("embedded parent is verified independently even if source ID/hash matches", async () => {
  const f = fixture();
  try {
    f.wrongParent();
    await assert.rejects(
      f.service.request(
        identity,
        scope,
        "read",
        { toolId: "foundry_get_actor_item", args: { actorId: "owner", itemId: "actor" } },
        undefined,
        new AbortController().signal,
      ),
      /scope|hash/,
    );
  } finally {
    f.db.close();
  }
});
void test("source hash uses binary recursive order and excludes stats but review includes stats", () => {
  const value = { Z: 1, a: { _stats: { x: 1 }, A: 2 }, _stats: { private: 3 } };
  assert.equal(worldCanonicalJson(value, true), '{"Z":1,"a":{"A":2}}');
  assert.equal(worldSourceRevision(value), worldSourceRevision({ a: { A: 2 }, Z: 1 }));
  assert.notEqual(worldCanonicalJson(value), worldCanonicalJson({ a: { A: 2 }, Z: 1 }));
});

void test("first manual GM turn discovers, loads and executes world setter with durable receipt through adapter", async () => {
  const f = fixture();
  try {
    f.largeSource();
    const actions = new ChatKitNativeActions(f.client, f.db, () => Promise.resolve());
    const catalog = new TrustedToolCatalog(
      new FoundryLocalApiProviderAdapter({ client: f.client, providerVersion: "fixture" }),
      CHATKIT_READ_TOOL_METADATA,
      "fixture",
    );
    const adapter = new ChatKitReadTools(f.client, () => Promise.resolve(), catalog, {
      internalSecret: "test",
      actions,
    });
    const run = adapter.begin(
      identity,
      { params: { thread_id: "thread" } },
      new AbortController().signal,
      authority,
    );
    const execute = (operation: string, args: unknown) =>
      adapter.execute(run.token, scope, operation, args, new AbortController().signal);
    const search = obj(
      await execute("tool_search", { query: "update actor world document", limit: 8 }),
    );
    assert.equal(search["ok"], true);
    const loaded = obj(
      await execute("tool_load", {
        searchId: obj(search["value"]!)["searchId"],
        toolId: "ai_dm_world_update_actor",
      }),
    );
    assert.equal(loaded["ok"], true);
    const grantId = obj(obj(loaded["value"]!)["grant"]!)["grantId"];
    const result = await execute("tool_execute", {
      grantId,
      effect: "session",
      arguments: {
        args: { id: "actor", changes: { name: "Direct first turn" } },
        actionId: "joined",
        expectedRevision: worldSourceRevision(f.source),
      },
    });
    assert.match(JSON.stringify(result), /"status":"completed"/);
    assert.equal(f.applies, 1);
    run.release();
  } finally {
    f.db.close();
  }
});
