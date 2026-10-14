import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldCampaignContext } from "../context/world-campaign.js";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { ChatKitReadTools, type ChatKitReadOptions } from "./read-tools.js";
import {
  CHATKIT_READ_TOOL_METADATA,
  FoundryLocalApiProviderAdapter,
  TrustedToolCatalog,
  type FoundryLocalApiMcpClient,
} from "../tool-catalog/index.js";
import { createAiDmApp } from "../app.js";
const identity: AiDmAuthenticatedIdentity = {
  clientId: "c",
  worldId: "w",
  userId: "gm",
  lane: "gm",
  isGm: true,
};
const scope = { worldId: "w", userId: "gm", threadId: "t" };
function fixture(
  options: Partial<ChatKitReadOptions> = {},
  actors: Record<string, AiDmJsonValue> = {},
) {
  let revoked = false;
  let world = "w";
  let hold = false;
  let after: (() => void) | undefined;
  const calls: string[] = [];
  const client: FoundryLocalApiMcpClient = {
    listTools: () =>
      Promise.resolve(
        CHATKIT_READ_TOOL_METADATA.map((m) => ({
          name: m.toolId,
          inputSchema: {
            type: "object",
            properties: m.toolId === "foundry_list_scenes" ? {} : { id: { type: "string" } },
            additionalProperties: false,
          },
        })),
      ),
    callTool: async ({ name, arguments: input }) => {
      calls.push(name);
      if (hold) return new Promise(() => {});
      let result: AiDmJsonValue;
      if (name === "foundry_list_scenes") result = [{ _id: "s", active: true }];
      else if (name === "foundry_get_world") result = { id: "w", system: "dnd5e" };
      else if (name === "foundry_get_system")
        result = { id: "dnd5e", version: "5.3.2", title: "D&D 5e" };
      else if (name === "foundry_list_combats")
        result = [{ _id: "combat", active: true, scene: "s", round: 1, turn: 0 }];
      else if (name === "foundry_get_scene")
        result = {
          _id: "s",
          active: true,
          name: "Hall",
          tokens: [{ _id: "token", actorId: "a", hidden: false }],
          secret: "not-exposed",
        };
      else if (name === "foundry_get_actor" && actors[(input as { id: string }).id])
        result = actors[(input as { id: string }).id]!;
      else
        result = {
          _id: "a",
          name: "Hero",
          type: "character",
          hasPlayerOwner: true,
          system: { attributes: { hp: { value: 10, max: 12 }, ac: { value: 14 } } },
          secret: "not-exposed",
        };
      after?.();
      return result;
    },
  };
  const catalog = new TrustedToolCatalog(
    new FoundryLocalApiProviderAdapter({ client, providerVersion: "fixture" }),
    CHATKIT_READ_TOOL_METADATA,
    "fixture",
  );
  const authorize = async () => {
    await Promise.resolve();
    if (revoked || world !== identity.worldId) throw new Error("authorization revoked");
  };
  const adapter = new ChatKitReadTools(client, authorize, catalog, {
    internalSecret: "internal",
    ...options,
  });
  const controller = new AbortController();
  const begin = (body: unknown = { params: { thread_id: "t" } }) =>
    adapter.begin(identity, body, controller.signal);
  return {
    adapter,
    controller,
    calls,
    begin,
    revoke: () => {
      revoked = true;
    },
    switchWorld: () => {
      world = "other";
    },
    hold: () => {
      hold = true;
    },
    after: (fn: () => void) => {
      after = fn;
    },
  };
}
void describe("ChatKit bounded adapter (controlled MCP fixture; no model)", () => {
  void it("guarantees overview and explicitly assigned off-scene party while surfacing unassigned characters", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-dm-party-"));
    try {
      const path = join(root, "w", "data", "campaign");
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "overview.md"),
        "---\nschema_version: 1\nid: campaign-main\nrevision: r1\nvisibility: gm\ncanon_status: canon\nparty_actor_ids: hero\n---\nSolo lighthouse adventure.",
      );
      const f = fixture(
        { campaign: new WorldCampaignContext(root) },
        { hero: { _id: "hero", name: "Assigned Hero", type: "character" } },
      );
      const run = f.begin();
      const result = (await f.adapter.execute(
        run.token,
        scope,
        "context",
        { query: "unrelated" },
        new AbortController().signal,
      )) as Record<string, AiDmJsonValue>;
      assert.match(JSON.stringify(result["campaignOverview"]), /Solo lighthouse/);
      assert.match(JSON.stringify(result["characters"]), /Assigned Hero/);
      assert.doesNotMatch(JSON.stringify(result["characters"]), /"id":"a"/);
      const actor = await f.adapter.execute(
        run.token,
        scope,
        "actor",
        { id: "hero" },
        new AbortController().signal,
      );
      assert.match(JSON.stringify(actor), /Assigned Hero/);
      writeFileSync(
        join(path, "overview.md"),
        "---\nschema_version: 1\nid: campaign-main\nrevision: r2\nvisibility: gm\ncanon_status: canon\n---\nUpdated lighthouse.",
      );
      const ambiguous = fixture(
        { campaign: new WorldCampaignContext(root) },
        { a: { _id: "a", name: "Unassigned", type: "character" } },
      );
      const updated = (await ambiguous.adapter.execute(
        ambiguous.begin().token,
        scope,
        "context",
        {},
        new AbortController().signal,
      )) as Record<string, AiDmJsonValue>;
      assert.deepEqual(updated["characters"], []);
      assert.match(JSON.stringify(updated["party"]), /unresolved/);
      assert.match(JSON.stringify(updated["campaignOverview"]), /Updated lighthouse/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  void it("builds equivalent authorized campaign/rules/character/combat context for prompts and actions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-dm-adapter-"));
    try {
      const path = join(root, "w", "data", "campaign");
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "room.md"),
        "---\nfoundry_scene_id: s\n---\n# Hall\n## PLAYER-VISIBLE\nA blue lantern shines.\n## GM-ONLY\nSecret dragon password.",
      );
      const f = fixture({ campaign: new WorldCampaignContext(root) });
      const ordinary = f.begin();
      const action = f.begin({
        params: {
          thread_id: "t",
          action: { payload: { prompt: "blue lantern", context: { sceneId: "spoof" } } },
        },
      });
      const read = (token: string) =>
        f.adapter.execute(
          token,
          scope,
          "context",
          { query: "blue lantern" },
          new AbortController().signal,
        );
      const a = await read(ordinary.token);
      assert.deepEqual(a, await read(action.token));
      const result = a as unknown as {
        rulesSystem: { id: string };
        combat: { round: number };
        characters: Array<{ state: { hp: { value: number } } }>;
        campaign: { excerpts: Array<{ narrationAllowed: boolean }> };
      };
      assert.equal(result.rulesSystem.id, "dnd5e");
      assert.equal(result.combat.round, 1);
      assert.equal(result.characters[0]?.state.hp.value, 10);
      assert.ok(
        result.campaign.excerpts.some((v: { narrationAllowed: boolean }) => v.narrationAllowed),
      );
      assert.doesNotMatch(JSON.stringify(result), /not-exposed/);
      const utility = await f.adapter.execute(
        ordinary.token,
        scope,
        "campaign_validate_sources",
        {},
        new AbortController().signal,
      );
      assert.match(JSON.stringify(utility), /campaign_validate_sources/);
      await assert.rejects(
        f.adapter.execute(
          ordinary.token,
          scope,
          "campaign",
          { query: "x".repeat(257) },
          new AbortController().signal,
        ),
      );
      f.switchWorld();
      await assert.rejects(read(ordinary.token));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  void it("reads selected scene and actor through reviewed catalog and projects results", async () => {
    const f = fixture();
    const run = f.begin();
    const result = await f.adapter.execute(
      run.token,
      scope,
      "context",
      {},
      new AbortController().signal,
    );
    assert.match(JSON.stringify(result), /Hall/);
    assert.doesNotMatch(JSON.stringify(result), /not-exposed/);
    const actor = await f.adapter.execute(
      run.token,
      scope,
      "actor",
      { id: "a" },
      new AbortController().signal,
    );
    assert.match(JSON.stringify(actor), /Hero/);
    assert.doesNotMatch(JSON.stringify(actor), /not-exposed/);
    await assert.rejects(
      f.adapter.execute(
        run.token,
        scope,
        "actor",
        { id: "elsewhere" },
        new AbortController().signal,
      ),
    );
    assert.ok(f.calls.every((n) => CHATKIT_READ_TOOL_METADATA.some((m) => m.toolId === n)));
    run.release();
    await assert.rejects(
      f.adapter.execute(run.token, scope, "scene", {}, new AbortController().signal),
    );
  });
  void it("does not trust hinted scene and uses equivalent ordinary/action context", async () => {
    const f = fixture();
    const ordinary = f.begin();
    const action = f.begin({
      params: { thread_id: "t", action: { payload: { context: { sceneId: "spoofed" } } } },
    });
    assert.deepEqual(
      await f.adapter.execute(ordinary.token, scope, "context", {}, new AbortController().signal),
      await f.adapter.execute(action.token, scope, "context", {}, new AbortController().signal),
    );
  });
  void it("denies revoked GM and switched world including revocation during provider read", async () => {
    for (const revoke of ["revoke", "switchWorld"] as const) {
      const f = fixture();
      const run = f.begin();
      f[revoke]();
      await assert.rejects(
        f.adapter.execute(run.token, scope, "scene", {}, new AbortController().signal),
      );
      assert.equal(f.calls.length, 0);
    }
    const f = fixture();
    const run = f.begin();
    f.after(f.revoke);
    await assert.rejects(
      f.adapter.execute(run.token, scope, "scene", {}, new AbortController().signal),
    );
    assert.equal(f.calls.length, 1);
  });
  void it("binds world, user, thread and denies malformed/unreviewed operations before any read", async () => {
    const f = fixture();
    const run = f.begin();
    for (const changed of [{ worldId: "other" }, { userId: "other" }, { threadId: "other" }])
      await assert.rejects(
        f.adapter.execute(
          run.token,
          { ...scope, ...changed },
          "scene",
          {},
          new AbortController().signal,
        ),
      );
    for (const [op, args] of [
      ["mutate", {}],
      ["scene", { id: "s" }],
      ["actor", { id: "../secret" }],
      ["actor", {}],
      ["scene", []],
    ] as const)
      await assert.rejects(
        f.adapter.execute(run.token, scope, op, args, new AbortController().signal),
      );
    assert.equal(f.calls.length, 0);
    const fresh = f.begin({ params: {} });
    await f.adapter.execute(fresh.token, scope, "scene", {}, new AbortController().signal);
    await assert.rejects(
      f.adapter.execute(
        fresh.token,
        { ...scope, threadId: "other" },
        "scene",
        {},
        new AbortController().signal,
      ),
    );
  });
  void it("expires capabilities and enforces per-run call budget", async () => {
    let now = 0;
    const f = fixture({ now: () => now, ttlMs: 100 });
    const run = f.begin();
    now = 100;
    await assert.rejects(
      f.adapter.execute(run.token, scope, "scene", {}, new AbortController().signal),
    );
    const fresh = f.begin();
    for (let i = 0; i < 12; i++)
      await f.adapter.execute(fresh.token, scope, "scene", {}, new AbortController().signal);
    await assert.rejects(
      f.adapter.execute(fresh.token, scope, "scene", {}, new AbortController().signal),
      /budget/,
    );
  });
  void it("bounds noncooperative provider timeout and cancels on run/client disconnect", async () => {
    // A real keepalive keeps Node alive while AbortSignal.timeout is unref'd.
    const keepalive = setInterval(() => {}, 1000);
    try {
      const f = fixture({ timeoutMs: 30 });
      const run = f.begin();
      f.hold();
      await assert.rejects(
        f.adapter.execute(run.token, scope, "scene", {}, new AbortController().signal),
        /timeout/i,
      );
      for (const kind of ["run", "disconnect"]) {
        const g = fixture();
        const r = g.begin();
        g.hold();
        const disconnect = new AbortController();
        const promise = g.adapter.execute(r.token, scope, "scene", {}, disconnect.signal);
        setTimeout(() => (kind === "run" ? g.controller : disconnect).abort(), 10);
        await assert.rejects(promise);
      }
    } finally {
      clearInterval(keepalive);
    }
  });
  void it("requires internal authentication plus scope at real HTTP boundary", async () => {
    const f = fixture();
    const run = f.begin();
    const app = createAiDmApp({
      chatkitReadHandler: f.adapter.handler,
      readiness: () => ({ ready: true, details: {} }),
    });
    const post = () =>
      request(app)
        .post("/internal/chatkit/read")
        .set("x-chatkit-read-run", run.token)
        .set("x-chatkit-world", "w")
        .set("x-chatkit-user", "gm")
        .set("x-chatkit-thread", "t");
    assert.equal((await post().send({ operation: "scene", arguments: {} })).status, 403);
    const good = await post()
      .set("x-chatkit-secret", "internal")
      .send({ operation: "scene", arguments: {} });
    assert.equal(good.status, 200);
    assert.equal((good.body as { ok: boolean }).ok, true);
    assert.equal(
      (
        await post()
          .set("x-chatkit-secret", "internal")
          .set("Origin", "http://localhost:30000")
          .send({ operation: "scene", arguments: {} })
      ).status,
      403,
    );
  });
});
