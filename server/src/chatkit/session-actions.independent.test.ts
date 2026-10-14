import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ChatKitSessionActions } from "./session-actions.js";
import { explicitSessionRequest } from "./pause-request.js";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";

void test("independent: combat advance must reject a receipt and independent read-back that agree on an invalid successor", async () => {
  const db = new DatabaseSync(":memory:");
  const action = { kind: "combat.next", sceneId: "scene", targetId: "combat" } as const;
  let state = { round: 1, turn: 0 };
  let effects = 0;
  const client: FoundryLocalApiMcpClient = {
    listTools: () =>
      Promise.resolve(
        ["foundry_get_session_action_state", "foundry_apply_session_action"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      ),
    callTool: async ({ name, arguments: args }) => {
      await Promise.resolve();
      const input = args as Record<string, unknown>;
      if (name === "foundry_apply_session_action") {
        effects++;
        state = { round: 99, turn: 99 };
        return { ...input, state, verified: true };
      }
      return { worldId: "world", action, state };
    },
  };
  const service = new ChatKitSessionActions(client, db, async () => {});
  const request = {
    type: "threads.add_user_message",
    params: {
      thread_id: "thread",
      input: { content: [{ type: "input_text", text: "advance the combat turn" }] },
    },
  };
  try {
    const result = await service.request(
      { clientId: "fixture", worldId: "world", userId: "gm", isGm: true, lane: "gm" },
      { worldId: "world", userId: "gm", threadId: "thread" },
      "native_session_apply",
      { actionId: "advance", action, expectedState: state },
      explicitSessionRequest(request),
      new AbortController().signal,
    );
    assert.equal((result as Record<string, unknown>)["status"], "uncertain");
    assert.equal(effects, 1);
  } finally {
    db.close();
  }
});
