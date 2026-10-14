import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { ChatKitCoreActions } from "./core-actions.js";
import { sessionActionSchema, sessionSemanticSchema } from "./session-actions.js";
import { ChatKitCatalogTools } from "./catalog-tools.js";
import { ChatKitNativeActions } from "./native-actions.js";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";

const gm: AiDmAuthenticatedIdentity = { worldId: "w", userId: "gm", clientId: "c", lane: "gm", isGm: true };
const scope = { worldId: "w", userId: "gm", threadId: "t" };
const authority = { worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) } };
const action = { kind: "token.light", sceneId: "s", targetId: "t", light: { bright: 10 } };
const object = (v: AiDmJsonValue) => v as Record<string, AiDmJsonValue>;

test("light schema admits partial patches and rejects unknown, unbounded and ambiguous fields", () => {
  assert.deepEqual(sessionActionSchema.parse(action), action);
  assert.equal(sessionActionSchema.safeParse({ ...action, light: { bright: 2, dim: 0 } }).success, true);
  for (const light of [{}, { bright: -1 }, { dim: 10001 }, { dim: 0.001 }, { alpha: 2 }, { vision: true }])
    assert.equal(sessionActionSchema.safeParse({ ...action, light }).success, false);
  assert.equal(sessionActionSchema.safeParse({ ...action, actorId: "all-linked" }).success, false);
  assert.ok(JSON.stringify(sessionSemanticSchema("ai_dm_set_token_light")).length < 1600);
});

test("core light requires matching native readback and fences missing acknowledgement without replay", async () => {
  for (const correct of [true, false]) {
    const db = new DatabaseSync(":memory:"); let calls = 0;
    const client: FoundryLocalApiMcpClient = { listTools: async () => [], callTool: async ({ arguments: args }) => {
      calls++; const input = object(args);
      return { ...input, outcome: "confirmed", mutated: true, state: { light: { bright: correct ? 10 : 99, dim: 20 } } };
    } };
    try {
      const service = new ChatKitCoreActions(client, db, async () => {});
      const args = { actionId: "a", action };
      const result = await service.request(gm, scope, args, authority, new AbortController().signal);
      assert.equal(object(result)["outcome"], correct ? "confirmed" : "uncertain");
      assert.deepEqual(await service.request(gm, scope, args, authority, new AbortController().signal), result);
      assert.equal(calls, 1);
    } finally { db.close(); }
  }
});

test("targeted light read injects authenticated scope and rejects wrong target, world and large data", async () => {
  const db = new DatabaseSync(":memory:"); let patch = {};
  const client: FoundryLocalApiMcpClient = { listTools: async () => [], callTool: async (request) => {
    assert.equal(request.name, "foundry_get_token_light");
    assert.deepEqual(request.arguments, { worldId: "w", userId: "gm", sceneId: "s", tokenId: "t" });
    return { worldId: "w", sceneId: "s", tokenId: "t", scope: "placed-token", units: "ft", light: { bright: 0, dim: 0 }, ...patch };
  } };
  try {
    const service = new ChatKitCoreActions(client, db, async () => {});
    const read = () => service.readTokenLight(gm, scope, { sceneId: "s", tokenId: "t" }, new AbortController().signal);
    assert.equal(object(await read())["units"], "ft");
    for (const bad of [{ worldId: "other" }, { tokenId: "other" }, { light: { x: "x".repeat(10001) } }]) {
      patch = bad; await assert.rejects(read);
    }
    await assert.rejects(service.readTokenLight({ ...gm, isGm: false }, scope, { sceneId: "s", tokenId: "t" }, new AbortController().signal));
  } finally { db.close(); }
});

test("light discovery requires installed native light capability and stays compact", async () => {
  for (const available of [true, false]) {
    const client: FoundryLocalApiMcpClient = { listTools: async () =>
      ["foundry_get_session_action_state", "foundry_apply_session_action", ...(available ? ["foundry_set_token_light"] : [])]
        .map(name => ({ name, inputSchema: { type: "object" } })), callTool: async () => assert.fail("discovery must not mutate") };
    const catalog = new ChatKitCatalogTools(client, { ...gm, connectionId: "c", role: 4,
      authorizedAudienceKinds: ["gm"], permissionSnapshotRevision: "fixture" }, async () => {}, async () => null, true);
    const result = JSON.stringify(await catalog.execute("tool_search", { query: "token emitted light", limit: 8 }, new AbortController().signal));
    assert.equal(result.includes("ai_dm_set_token_light"), available);
    assert.ok(result.length < 10000);
  }
});

test("lazy light discovery loads and executes targeted read, set and clear through durable native adapters", async () => {
  const db = new DatabaseSync(":memory:"); let mutations = 0;
  let state: Record<string, AiDmJsonValue> = { light: { bright: 0, dim: 0, alpha: 0.5, color: null } };
  const client: FoundryLocalApiMcpClient = {
    listTools: async () => ["foundry_get_session_action_state", "foundry_apply_session_action", "foundry_set_token_light", "foundry_get_token_light"]
      .map(name => ({ name, inputSchema: { type: "object" } })),
    callTool: async ({ name, arguments: args }) => {
      const input = object(args);
      if (name === "foundry_get_token_light") return { worldId: "w", sceneId: "s", tokenId: "t", scope: "placed-token", units: "ft", light: state["light"]! };
      if (name === "foundry_apply_session_action") {
        mutations++; state = { light: { ...object(state["light"]!), ...object(object(input["action"]!)["light"]!) } };
        return { ...input, state, verified: true };
      }
      if (name === "foundry_get_session_action_state") return { ...input, state };
      return assert.fail("Unexpected native call");
    },
  };
  try {
    const actions = new ChatKitNativeActions(client, db, async () => {});
    const signal = new AbortController().signal;
    const catalog = new ChatKitCatalogTools(client, { ...gm, connectionId: "c", role: 4,
      authorizedAudienceKinds: ["gm"], permissionSnapshotRevision: "fixture" }, async () => {},
      (operation, args, s) => actions.request(gm, scope, operation, args, s, undefined, authority), true);
    const load = async (toolId: string) => {
      const search = object(await catalog.execute("tool_search", { query: "token light", limit: 8 }, signal));
      const loaded = object(await catalog.execute("tool_load", { searchId: object(search["value"]!)["searchId"], toolId }, signal));
      assert.equal(loaded["ok"], true);
      return object(object(loaded["value"]!)["grant"]!)["grantId"]!;
    };
    const readGrant = await load("ai_dm_get_token_light");
    assert.match(JSON.stringify(await catalog.execute("tool_execute", { grantId: readGrant, effect: "read", arguments: { sceneId: "s", tokenId: "t" } }, signal)), /placed-token/);
    const grantId = await load("ai_dm_set_token_light");
    for (const [actionId, light] of [["set", { bright: 20 }], ["clear", { bright: 0, dim: 0 }]] as const) {
      const request = { grantId, effect: "session", arguments: { actionId, action: { ...action, light }, expectedState: state } };
      assert.match(JSON.stringify(await catalog.execute("tool_execute", request, signal)), /"status":"completed"/);
      assert.match(JSON.stringify(await catalog.execute("tool_execute", request, signal)), /"status":"completed"/);
    }
    assert.equal(mutations, 2);
    assert.deepEqual(state["light"], { bright: 0, dim: 0, alpha: 0.5, color: null });
  } finally { db.close(); }
});
