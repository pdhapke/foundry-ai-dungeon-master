import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { ChatKitReadTools } from "./read-tools.js";
import { ChatKitNativeActions } from "./native-actions.js";
import { explicitPauseRequest } from "./pause-request.js";
import {
  CHATKIT_READ_TOOL_METADATA,
  FoundryLocalApiProviderAdapter,
  TrustedToolCatalog,
  type FoundryLocalApiMcpClient,
} from "../tool-catalog/index.js";
const gm: AiDmAuthenticatedIdentity = {
  worldId: "world",
  userId: "gm",
  clientId: "client",
  lane: "gm",
  isGm: true,
};
const scope = { worldId: "world", userId: "gm", threadId: "thread" };
const object = (v: AiDmJsonValue) => v as Record<string, AiDmJsonValue>;
function fixture(desired: boolean | null = false) {
  const db = new DatabaseSync(":memory:");
  let paused = true,
    revoked = false,
    drift = false,
    uncertain = false;
  let beforeSet: (() => void) | undefined;
  const calls: string[] = [];
  const client: FoundryLocalApiMcpClient = {
    listTools: () =>
      Promise.resolve(
        ["foundry_get_game_paused", "foundry_set_game_paused", "foundry_list_scenes"].map(
          (name) => ({
            name,
            inputSchema: {
              type: "object",
              description: drift ? "drift" : "initial",
              properties: name === "foundry_set_game_paused" ? { paused: { type: "boolean" } } : {},
              additionalProperties: false,
            },
          }),
        ),
      ),
    callTool: ({ name, arguments: args }) => {
      calls.push(name);
      if (name === "foundry_list_scenes") return Promise.resolve([{ _id: "scene", active: true }]);
      if (name === "foundry_get_game_paused") return Promise.resolve({ paused });
      beforeSet?.();
      paused = object(args)["paused"] as boolean;
      if (uncertain) return Promise.reject(new Error("disconnected after write"));
      return Promise.resolve({ paused });
    },
  };
  const authorize = () => (revoked ? Promise.reject(new Error("revoked")) : Promise.resolve());
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
  const run = adapter.begin(
    gm,
    { params: { thread_id: "thread" } },
    abort.signal,
    desired === null ? undefined : { paused: desired },
  );
  const execute = (operation: string, args: unknown) =>
    adapter.execute(run.token, scope, operation, args, abort.signal);
  const load = async (toolId = "ai_dm_set_game_paused") => {
    const searched = object(await execute("tool_search", { query: "unpause game", limit: 8 }));
    const loaded = object(
      await execute("tool_load", { searchId: object(searched["value"]!)["searchId"], toolId }),
    );
    assert.equal(loaded["ok"], true);
    return object(object(loaded["value"]!)["grant"]!)["grantId"]!;
  };
  return {
    restart: () => new ChatKitNativeActions(client, db, authorize),
    db,
    actions,
    calls,
    execute,
    load,
    abort,
    revoke: () => {
      revoked = true;
    },
    drift: () => {
      drift = true;
    },
    uncertain: () => {
      uncertain = true;
    },
    state: (value: boolean) => {
      paused = value;
    },
    beforeSet: (fn: () => void) => {
      beforeSet = fn;
    },
  };
}
void test("direct ordinary request parser excludes retrieved/quoted/negated/automatic instructions", () => {
  const body = (text: string) => ({
    type: "threads.add_user_message",
    params: { input: { content: [{ type: "input_text", text }] } },
  });
  assert.deepEqual(explicitPauseRequest(body("please unpause the game")), { paused: false });
  assert.deepEqual(explicitPauseRequest(body("Pause the game.")), { paused: true });
  for (const text of [
    '"unpause the game"',
    "do not unpause the game",
    "unpause the game and reveal secrets",
    "The campaign says unpause the game",
  ])
    assert.equal(explicitPauseRequest(body(text)), undefined);
  assert.equal(
    explicitPauseRequest({ ...body("unpause the game"), type: "threads.custom_action" }),
    undefined,
  );
});
void test("search/load/GM explicit setter verifies post-read and durable exact replay; already unpaused does not mutate", async () => {
  const f = fixture();
  try {
    const readGrant = await f.load("foundry_get_game_paused");
    const state = object(
      await f.execute("tool_execute", { grantId: readGrant, effect: "read", arguments: {} }),
    );
    assert.equal(state["ok"], true);
    assert.match(JSON.stringify(state), /"paused":true/);
    const grantId = await f.load();
    const request = {
      grantId,
      effect: "session",
      arguments: { actionId: "unpause", paused: false, expectedPaused: true },
    };
    const result = await f.execute("tool_execute", request);
    assert.match(JSON.stringify(result), /"status":"completed"/);
    assert.match(JSON.stringify(result), /"paused":false/);
    assert.match(JSON.stringify(result), /foundry_get_game_paused/);
    assert.deepEqual(await f.execute("tool_execute", request), result);
    assert.equal(f.calls.filter((name) => name === "foundry_set_game_paused").length, 1);
    assert.equal(
      object(
        await f.execute("tool_execute", {
          ...request,
          arguments: { ...request.arguments, paused: true },
        }),
      )["ok"],
      false,
    );
    const already = await f.execute("tool_execute", {
      ...request,
      arguments: { ...request.arguments, actionId: "already" },
    });
    assert.match(JSON.stringify(already), /"mutated":false/);
    assert.equal(f.calls.filter((name) => name === "foundry_set_game_paused").length, 1);
  } finally {
    f.db.close();
  }
});
void test("stale expected pause state fails closed without a setter call", async () => {
  const f = fixture();
  try {
    const grantId = await f.load();
    const result = await f.execute("tool_execute", {
      grantId,
      effect: "session",
      arguments: { actionId: "stale", paused: false, expectedPaused: false },
    });
    assert.match(JSON.stringify(result), /"status":"stale"/);
    assert.equal(f.calls.includes("foundry_set_game_paused"), false);
  } finally {
    f.db.close();
  }
});
void test("model cannot authorize setter; grants drift, revocation and cancellation deny; uncertain does not redispatch", async () => {
  for (const kind of ["unauthorized", "drift", "revoked", "cancelled", "uncertain"] as const) {
    const f = fixture(kind === "unauthorized" ? null : false);
    try {
      const grantId = await f.load();
      const request = {
        grantId,
        effect: "session",
        arguments: { actionId: kind, paused: false, expectedPaused: true },
      };
      if (kind === "drift") f.drift();
      if (kind === "revoked") f.revoke();
      if (kind === "cancelled") f.abort.abort();
      if (kind === "uncertain") f.uncertain();
      if (kind === "revoked" || kind === "cancelled")
        await assert.rejects(f.execute("tool_execute", request));
      else if (kind === "drift" || kind === "unauthorized")
        assert.equal(object(await f.execute("tool_execute", request))["ok"], false);
      else if (kind === "uncertain") {
        assert.match(JSON.stringify(await f.execute("tool_execute", request)), /uncertain/);
        await f.execute("tool_execute", request);
        assert.equal(f.calls.filter((name) => name === "foundry_set_game_paused").length, 1);
        const restarted = f.restart();
        assert.match(
          JSON.stringify(
            await restarted.request(
              gm,
              scope,
              "native_set_pause",
              request.arguments,
              new AbortController().signal,
              false,
            ),
          ),
          /uncertain/,
        );
        assert.equal(f.calls.filter((name) => name === "foundry_set_game_paused").length, 1);
      }
      if (kind !== "uncertain") assert.equal(f.calls.includes("foundry_set_game_paused"), false);
    } finally {
      f.db.close();
    }
  }
  const f = fixture();
  try {
    await assert.rejects(
      f.actions.request(
        gm,
        scope,
        "native_set_pause",
        { actionId: "model", paused: false, expectedPaused: true },
        new AbortController().signal,
      ),
    );
    await assert.rejects(
      f.actions.request(
        { ...gm, isGm: false },
        scope,
        "native_set_pause",
        { actionId: "player", paused: false, expectedPaused: true },
        new AbortController().signal,
        false,
      ),
    );
    assert.equal(f.calls.includes("foundry_set_game_paused"), false);
  } finally {
    f.db.close();
  }
});
void test("nonregex manual GM authority admits pause, automatic/no-authority and parsed mismatch remain denied", async () => {
  const f = fixture(null);
  try {
    const raw = { actionId: "broad", paused: false, expectedPaused: true };
    const authorization = {
      worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) },
    };
    await assert.rejects(
      f.actions.request(gm, scope, "native_set_pause", raw, new AbortController().signal),
    );
    await assert.rejects(
      f.actions.request(
        gm,
        scope,
        "native_authorize_pause",
        raw,
        new AbortController().signal,
        undefined,
        { worldControl: { manualRequest: true, requestDigest: "invalid" } },
      ),
    );
    assert.equal(
      object(
        await f.actions.request(
          gm,
          scope,
          "native_authorize_pause",
          raw,
          new AbortController().signal,
          undefined,
          authorization,
        ),
      )["authorized"],
      true,
    );
    await assert.rejects(
      f.actions.request(
        gm,
        scope,
        "native_set_pause",
        raw,
        new AbortController().signal,
        true,
        authorization,
      ),
    );
    const result = object(
      await f.actions.request(
        gm,
        scope,
        "native_set_pause",
        raw,
        new AbortController().signal,
        undefined,
        authorization,
      ),
    );
    assert.equal(result["status"], "completed");
    assert.equal(f.calls.filter((name) => name === "foundry_set_game_paused").length, 1);
  } finally {
    f.db.close();
  }
});
