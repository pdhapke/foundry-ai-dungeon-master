import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ChatKitPauseActions } from "./pause-actions.js";
import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
const gm = { clientId: "c", worldId: "w", userId: "gm", lane: "gm" as const, isGm: true };
const scope = { worldId: "w", userId: "gm", threadId: "t" };
void test("independent: failed post-read/revoked dispatched mutation remains uncertain across restart", async () => {
  for (const mode of ["wrong-readback", "revoked-after-set"]) {
    const db = new DatabaseSync(":memory:");
    let paused = true;
    let setters = 0;
    let revoked = false;
    const client = {
      listTools: () =>
        Promise.resolve([
          { name: "foundry_get_game_paused", inputSchema: { type: "object", properties: {} } },
          {
            name: "foundry_set_game_paused",
            inputSchema: {
              type: "object",
              properties: { paused: { type: "boolean" } },
              required: ["paused"],
            },
          },
        ]),
      callTool: ({ name, arguments: args }: { name: string; arguments: AiDmJsonValue }) => {
        if (name === "foundry_set_game_paused") {
          setters++;
          if (mode !== "wrong-readback") paused = (args as { paused: boolean }).paused;
          if (mode === "revoked-after-set") revoked = true;
        }
        return Promise.resolve({ paused });
      },
    };
    const authorize = () => (revoked ? Promise.reject(new Error("revoked")) : Promise.resolve());
    const input = { actionId: "one", paused: false, expectedPaused: true };
    const actions = new ChatKitPauseActions(client, db, authorize);
    const result = await actions.request(gm, scope, input, false, new AbortController().signal);
    assert.match(JSON.stringify(result), /"status":"uncertain"/);
    assert.equal(setters, 1);
    revoked = false;
    const restarted = new ChatKitPauseActions(client, db, authorize);
    assert.match(
      JSON.stringify(
        await restarted.request(gm, scope, input, false, new AbortController().signal),
      ),
      /"status":"uncertain"/,
    );
    assert.equal(setters, 1);
    db.close();
  }
});
void test("independent: world/user/desired state mismatch denied before MCP reads", async () => {
  const db = new DatabaseSync(":memory:");
  let calls = 0;
  const actions = new ChatKitPauseActions(
    {
      listTools: () => {
        calls++;
        return Promise.resolve([]);
      },
      callTool: () => {
        calls++;
        return Promise.resolve(null);
      },
    },
    db,
    () => Promise.resolve(),
  );
  for (const wrong of [
    { ...scope, worldId: "other" },
    { ...scope, userId: "other" },
    { ...scope, threadId: "" },
  ])
    await assert.rejects(
      actions.request(
        gm,
        wrong,
        { actionId: "one", paused: false, expectedPaused: true },
        false,
        new AbortController().signal,
      ),
    );
  await assert.rejects(
    actions.request(
      gm,
      scope,
      { actionId: "one", paused: true, expectedPaused: true },
      false,
      new AbortController().signal,
    ),
  );
  assert.equal(calls, 0);
  db.close();
});
