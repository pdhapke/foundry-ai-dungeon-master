import assert from "node:assert/strict";
import test from "node:test";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { ChatKitReadTools } from "./read-tools.js";
import { CHATKIT_READ_TOOL_METADATA, FoundryLocalApiProviderAdapter, TrustedToolCatalog, type FoundryLocalApiMcpClient } from "../tool-catalog/index.js";

const identity: AiDmAuthenticatedIdentity = { clientId: "c", worldId: "w", userId: "gm", lane: "gm", isGm: true };
const scope = { worldId: "w", userId: "gm", threadId: "t" };
function fixture() {
  let revoked = false, world = "w", revision = 1;
  const calls: string[] = [];
  const client: FoundryLocalApiMcpClient = {
    listTools: async () => CHATKIT_READ_TOOL_METADATA.map(m => ({ name: m.toolId, inputSchema: { type: "object", properties: m.toolId === "foundry_get_scene" ? { id: { type: "string" } } : {}, additionalProperties: false } })),
    callTool: async ({ name }) => {
      calls.push(name);
      if (name === "foundry_get_world") return { id: world, system: "dnd5e" };
      if (name === "foundry_list_scenes") return [{ _id: "s", active: true }];
      if (name === "foundry_get_system") return { id: "dnd5e", version: "5.3.2" };
      if (name === "foundry_list_combats") return [];
      if (name === "foundry_get_scene") return { _id: "s", active: true, name: `Revision ${revision}`, tokens: [] };
      assert.fail(`Unrelated retrieval ${name}`);
    },
  };
  const catalog = new TrustedToolCatalog(new FoundryLocalApiProviderAdapter({ client, providerVersion: "fixture" }), CHATKIT_READ_TOOL_METADATA, "fixture");
  const adapter = new ChatKitReadTools(client, async () => { if (revoked) throw new Error("revoked"); }, catalog, { internalSecret: "fixture" });
  const signal = new AbortController().signal;
  const begin = (text: string) => adapter.begin(identity, { params: { thread_id: "t", input: { content: [{ text }] } } }, signal);
  const read = (token: string) => adapter.execute(token, scope, "initial_context", {}, signal);
  return { adapter, calls, begin, read, signal, revoke: () => { revoked = true; }, change: () => { revision++; }, switchWorld: () => { world = "other"; } };
}
void test("independent equivalent wording uses fresh bounded context with no actor or campaign expansion", async () => {
  const f = fixture();
  const a = f.begin("Set HP to 18");
  const first = await f.read(a.token);
  const b = f.begin("Please carefully set the specified actor current hit points to exactly 18 and confirm the result");
  assert.deepEqual(await f.read(b.token), first);
  assert.equal(f.calls.length, 10);
  f.change();
  const changed = await f.read(b.token) as Record<string, AiDmJsonValue>;
  assert.equal((changed["scene"] as Record<string, AiDmJsonValue>)["name"], "Revision 2");
  a.release(); b.release();
});
void test("independent context rejects wrong user/world, released reconnect runs and live permission revocation", async () => {
  const f = fixture(), run = f.begin("Open door");
  for (const principal of [{ ...scope, userId: "other" }, { ...scope, worldId: "other" }])
    await assert.rejects(f.adapter.execute(run.token, principal, "initial_context", {}, f.signal), /scope/);
  assert.equal(f.calls.length, 0);
  await f.read(run.token);
  f.revoke();
  await assert.rejects(f.read(run.token), /revoked/);
  run.release();
  await assert.rejects(f.read(run.token), /expired/);
  const g = fixture(), other = g.begin("Move token");
  g.switchWorld();
  await assert.rejects(g.read(other.token), /World changed/);
  other.release();
});
