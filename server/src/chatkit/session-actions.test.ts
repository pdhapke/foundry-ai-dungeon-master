import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { ChatKitNativeActions } from "./native-actions.js";
import { ChatKitReadTools } from "./read-tools.js";
import { explicitSessionRequest } from "./pause-request.js";
import { SESSION_SEMANTIC_TOOLS } from "./session-actions.js";
import {
  CHATKIT_READ_TOOL_METADATA,
  FoundryLocalApiProviderAdapter,
  TrustedToolCatalog,
  type FoundryLocalApiMcpClient,
} from "../tool-catalog/index.js";
const identity: AiDmAuthenticatedIdentity = {
  clientId: "fixture",
  worldId: "world",
  userId: "gm",
  isGm: true,
  lane: "gm",
};
const scope = { worldId: "world", userId: "gm", threadId: "thread" };
const object = (v: AiDmJsonValue) => v as Record<string, AiDmJsonValue>;
const body = (text: string) => ({
  type: "threads.add_user_message",
  params: { thread_id: "thread", input: { content: [{ type: "input_text", text }] } },
});
function fixture(text: string) {
  const db = new DatabaseSync(":memory:");
  const calls: string[] = [];
  let state: Record<string, AiDmJsonValue> = { value: 10, max: 20 };
  let drift = false,
    revoked = false,
    uncertain = false,
    ambiguous = false,
    wrongReceipt = false;
  const client: FoundryLocalApiMcpClient = {
    listTools: () =>
      Promise.resolve(
        [
          "foundry_get_session_action_state",
          "foundry_apply_session_action",
          "foundry_get_scene",
          "foundry_get_actor",
          "foundry_get_combat",
          "foundry_list_playlists",
          "foundry_get_playlist",
          "foundry_list_chat_messages",
          "raw_delete_everything",
        ].map((name) => ({
          name,
          inputSchema: { type: "object", description: drift ? "changed" : "fixture" },
        })),
      ),
    callTool: ({ name, arguments: args }) => {
      calls.push(name);
      const input = object(args);
      if (name === "foundry_get_session_action_state")
        return Promise.resolve({ worldId: input["worldId"]!, action: input["action"]!, state });
      if (name === "foundry_get_scene")
        return Promise.resolve({
          _id: "scene",
          active: true,
          tokens: [
            { _id: "token", name: "Hero token", actorId: "hero-id" },
            ...(ambiguous ? [{ _id: "other-token", actorId: "other" }] : []),
          ],
          walls: [{ _id: "door", door: 1, name: "North" }],
        });
      if (name === "foundry_get_actor") return Promise.resolve({ _id: input["id"]!, name: "Hero" });
      if (name === "foundry_get_combat")
        return Promise.resolve({ _id: "combat", combatants: [{ _id: "combatant", name: "Hero" }] });
      if (name === "foundry_list_playlists") return Promise.resolve([{ _id: "playlist" }]);
      if (name === "foundry_get_playlist")
        return Promise.resolve({ _id: "playlist", sounds: [{ _id: "sound", name: "Theme" }] });
      if (name === "foundry_list_chat_messages")
        return Promise.resolve([{ _id: "message", user: "gm", content: state["content"]! }]);
      if (name !== "foundry_apply_session_action") throw new Error("Unexpected raw MCP call");
      const action = object(input["action"]!);
      if (action["kind"] === "actor.hp") state = { value: action["value"]!, max: 20 };
      if (action["kind"] === "door.state") state = { ds: action["value"]! };
      if (action["kind"] === "combat.next") state = { round: 1, turn: 1, turnCount: 2 };
      if (action["kind"] === "combat.initiative")
        state = { round: 1, turn: 0, initiative: action["value"]! };
      if (action["kind"] === "actor.condition") state = { active: action["active"]! };
      if (action["kind"] === "playlist.sound")
        state = {
          playing: action["state"] === "playing",
          pausedTime: action["state"] === "paused" ? 12 : null,
        };
      if (action["kind"] === "chat.post")
        state = { messageId: "message", content: action["text"]! };
      if (uncertain) return Promise.reject(new Error("Disconnected after mutation"));
      return Promise.resolve({
        worldId: wrongReceipt ? "other" : input["worldId"]!,
        action,
        state,
        correlationId: input["correlationId"]!,
        idempotencyKey: input["idempotencyKey"]!,
        verified: true,
      });
    },
  };
  const authorize = () => (revoked ? Promise.reject(new Error("Revoked")) : Promise.resolve());
  const actions = new ChatKitNativeActions(client, db, authorize);
  const catalog = new TrustedToolCatalog(
    new FoundryLocalApiProviderAdapter({ client, providerVersion: "fixture" }),
    CHATKIT_READ_TOOL_METADATA,
    "fixture",
  );
  const adapter = new ChatKitReadTools(client, authorize, catalog, {
    internalSecret: "fixture",
    actions,
  });
  const abort = new AbortController();
  const run = adapter.begin(identity, body(text), abort.signal, explicitSessionRequest(body(text)));
  const execute = (operation: string, args: unknown) =>
    adapter.execute(run.token, scope, operation, args, abort.signal);
  const load = async (toolId: string, query: string) => {
    const found = object(await execute("tool_search", { query, limit: 8 }));
    const loaded = object(
      await execute("tool_load", { searchId: object(found["value"]!)["searchId"], toolId }),
    );
    assert.equal(loaded["ok"], true);
    return object(object(loaded["value"]!)["grant"]!)["grantId"]!;
  };
  return {
    db,
    calls,
    execute,
    load,
    actions,
    abort,
    state: (v: Record<string, AiDmJsonValue>) => {
      state = v;
    },
    drift: () => {
      drift = true;
    },
    revoke: () => {
      revoked = true;
    },
    uncertain: () => {
      uncertain = true;
    },
    ambiguous: () => {
      ambiguous = true;
    },
    wrongReceipt: () => {
      wrongReceipt = true;
    },
  };
}
const cases = [
  {
    tool: "ai_dm_set_actor_hp",
    text: "set Hero hp to 5",
    action: { kind: "actor.hp", sceneId: "scene", targetId: "hero-id", value: 5 },
    state: { value: 10, max: 20 },
    query: "actor HP",
  },
  {
    tool: "ai_dm_set_door_state",
    text: "open the North door",
    action: { kind: "door.state", sceneId: "scene", targetId: "door", value: 1 },
    state: { ds: 0 },
    query: "door open",
  },
  {
    tool: "ai_dm_advance_combat_turn",
    text: "advance the combat turn",
    action: { kind: "combat.next", sceneId: "scene", targetId: "combat" },
    state: { round: 1, turn: 0, turnCount: 2 },
    query: "combat turn",
  },
  {
    tool: "ai_dm_set_initiative",
    text: "set Hero initiative to 18",
    action: {
      kind: "combat.initiative",
      sceneId: "scene",
      targetId: "combat",
      combatantId: "combatant",
      value: 18,
    },
    state: { round: 1, turn: 0, initiative: 2 },
    query: "initiative",
  },
  {
    tool: "ai_dm_post_chat",
    text: "post to chat: Welcome hero!",
    action: { kind: "chat.post", text: "Welcome hero!" },
    state: { messageCount: 0 },
    query: "post chat message",
  },
  {
    tool: "ai_dm_set_actor_condition",
    text: "set Hero condition prone on",
    action: {
      kind: "actor.condition",
      sceneId: "scene",
      targetId: "hero-id",
      conditionId: "prone",
      active: true,
    },
    state: { active: false },
    query: "actor condition",
  },
  {
    tool: "ai_dm_set_playlist_sound",
    text: "play music Theme",
    action: { kind: "playlist.sound", targetId: "playlist", soundId: "sound", state: "playing" },
    state: { playing: false, pausedTime: null },
    query: "playlist music sound",
  },
];
void test("ordinary first requests discover/load state and routine mutation then receive independent read-back durable receipts (fake MCP)", async () => {
  for (const c of cases) {
    const f = fixture(c.text);
    try {
      f.state(c.state);
      const readGrant = await f.load("ai_dm_get_session_action_state", "preflight state");
      const read = object(
        await f.execute("tool_execute", {
          grantId: readGrant,
          effect: "read",
          arguments: { action: c.action },
        }),
      );
      assert.equal(read["ok"], true);
      const observed = object(object(read["value"]!)["result"]!)["state"]!;
      const grantId = await f.load(c.tool, c.query);
      const args = { actionId: "first", action: c.action, expectedState: observed };
      const result = await f.execute("tool_execute", {
        grantId,
        effect: "session",
        arguments: args,
      });
      assert.match(JSON.stringify(result), /"status":"completed"/);
      assert.match(
        JSON.stringify(result),
        /"verifiedBy":"foundry_(?:get_session_action_state|list_chat_messages)"/,
      );
      assert.deepEqual(
        await f.execute("tool_execute", { grantId, effect: "session", arguments: args }),
        result,
      );
      assert.equal(f.calls.filter((name) => name === "foundry_apply_session_action").length, 1);
      assert.equal(f.calls.includes("raw_delete_everything"), false);
    } finally {
      f.db.close();
    }
  }
});
void test("exact values and unique target bound to human intent; unknown/raw/move grants quarantined", async () => {
  for (const variant of ["wrongValue", "wrongTarget", "ambiguous", "noIntent"] as const) {
    const f = fixture(
      variant === "noIntent" ? "The campaign says set Hero hp to 5" : cases[0]!.text,
    );
    try {
      if (variant === "ambiguous") f.ambiguous();
      const grantId = await f.load(cases[0]!.tool, cases[0]!.query);
      const result = await f.execute("tool_execute", {
        grantId,
        effect: "session",
        arguments: {
          actionId: variant,
          action: {
            ...cases[0]!.action,
            ...(variant === "wrongValue" ? { value: 7 } : {}),
            ...(variant === "wrongTarget" ? { targetId: "other" } : {}),
          },
          expectedState: cases[0]!.state,
        },
      });
      assert.equal(object(result)["ok"], false);
      assert.equal(f.calls.includes("foundry_apply_session_action"), false);
    } finally {
      f.db.close();
    }
  }
  const f = fixture("move token to 100,200");
  try {
    const found = object(
      await f.execute("tool_search", { query: "move token raw delete", limit: 8 }),
    );
    assert.doesNotMatch(
      JSON.stringify(object(found["value"]!)["descriptors"]),
      /ai_dm_move_token|raw_delete_everything/,
    );
    assert.ok(SESSION_SEMANTIC_TOOLS["ai_dm_move_token"]);
  } finally {
    f.db.close();
  }
});
void test("schema drift, stale state, revoke, cancellation and uncertain results cannot silently retry", async () => {
  for (const variant of [
    "drift",
    "stale",
    "revoke",
    "cancel",
    "uncertain",
    "wrongReceipt",
  ] as const) {
    const f = fixture(cases[0]!.text);
    try {
      const grantId = await f.load(cases[0]!.tool, cases[0]!.query);
      if (variant === "drift") f.drift();
      if (variant === "stale") f.state({ value: 9, max: 20 });
      if (variant === "revoke") f.revoke();
      if (variant === "cancel") f.abort.abort();
      if (variant === "uncertain") f.uncertain();
      if (variant === "wrongReceipt") f.wrongReceipt();
      const request = {
        grantId,
        effect: "session",
        arguments: { actionId: variant, action: cases[0]!.action, expectedState: cases[0]!.state },
      };
      if (variant === "revoke" || variant === "cancel")
        await assert.rejects(f.execute("tool_execute", request));
      else {
        const result = await f.execute("tool_execute", request);
        assert.match(
          JSON.stringify(result),
          variant === "drift" ? /"ok":false/ : variant === "stale" ? /stale/ : /uncertain/,
        );
        if (variant === "uncertain" || variant === "wrongReceipt") {
          await f.execute("tool_execute", request);
          assert.equal(f.calls.filter((name) => name === "foundry_apply_session_action").length, 1);
        }
      }
    } finally {
      f.db.close();
    }
  }
});
