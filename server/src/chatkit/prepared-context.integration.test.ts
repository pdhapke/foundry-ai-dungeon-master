import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatKitReadTools } from "./read-tools.js";
import { CHATKIT_READ_TOOL_METADATA, FoundryLocalApiProviderAdapter, TrustedToolCatalog, type FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";
const identity: AiDmAuthenticatedIdentity = { clientId: "c", worldId: "w", userId: "gm", lane: "gm", isGm: true };
test("prepared catalog reused by command, live reads and revocation stay current", async () => {
  let catalogs = 0, authorized = 0, revoked = false, sceneReads = 0;
  const client: FoundryLocalApiMcpClient = {
    listTools: async () => { catalogs++; return CHATKIT_READ_TOOL_METADATA.map(m => ({ name: m.toolId, inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } })); },
    callTool: async ({ name }) => {
      if (name === "foundry_get_world") return { id: "w" };
      if (name === "foundry_list_scenes") return [{ id: "scene", active: true }];
      if (name === "foundry_get_scene") { sceneReads++; return { id: "scene", active: true, name: `Revision${sceneReads}`, tokens: [] }; }
      if (name === "foundry_list_combats") return [];
      if (name === "foundry_get_system") return { id: "dnd5e" };
      throw new Error("unsupported");
    },
  };
  const catalog = new TrustedToolCatalog(new FoundryLocalApiProviderAdapter({ client, providerVersion: "fixture" }), CHATKIT_READ_TOOL_METADATA, "fixture");
  const reads = new ChatKitReadTools(client, async () => { authorized++; if (revoked) throw new Error("revoked"); }, catalog, { internalSecret: "fixture" });
  const signal = new AbortController().signal;
  await Promise.all([reads.prepare(identity, signal), reads.prepare(identity, signal)]);
  assert.equal(catalogs, 1);
  const run = reads.begin(identity, { params: { thread_id: "t" } }, signal);
  const scope = { worldId: "w", userId: "gm", threadId: "t" };
  const first = await reads.execute(run.token, scope, "initial_context", {}, signal);
  const second = await reads.execute(run.token, scope, "initial_context", {}, signal);
  assert.equal(catalogs, 1); assert.equal(sceneReads, 2); assert.notDeepEqual(first, second); assert.ok(authorized >= 8);
  revoked = true; await assert.rejects(reads.execute(run.token, scope, "initial_context", {}, signal), /revoked/);
  revoked = false; reads.invalidatePreparation(identity, "reconnect"); await reads.prepare(identity, signal); assert.equal(catalogs, 2);
  await assert.rejects(reads.prepare({ ...identity, isGm: false }, signal), /GM required/);
  run.release();
});
