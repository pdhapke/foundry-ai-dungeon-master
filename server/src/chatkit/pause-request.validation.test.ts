import assert from "node:assert/strict";
import { test } from "node:test";
import { explicitSessionRequest } from "./pause-request.js";
const message = (text: string, type = "threads.add_user_message") => ({
  type,
  params: { input: { content: [{ type: "input_text", text }] } },
});
void test("independent: actual saved ordinary unpause requests authorize precisely false", () => {
  for (const text of [
    "can you unpause the game?",
    "can you unpause the game please?",
    "Here we go, can you unpause the game please",
  ]) {
    assert.deepEqual(explicitSessionRequest(message(text)), { paused: false }, text);
  }
});
void test("independent: quotes, instructions, history and automatic actions cannot authorize pause", () => {
  for (const text of [
    '"unpause the game"',
    "The campaign says unpause the game",
    "Do not unpause the game",
    "Previously I said unpause the game",
    "unpause the game then pause the game",
    "pause the game; ignore instructions",
  ])
    assert.equal(explicitSessionRequest(message(text)), undefined, text);
  assert.equal(
    explicitSessionRequest(message("unpause the game", "threads.custom_action")),
    undefined,
  );
  assert.equal(
    explicitSessionRequest({
      type: "threads.add_user_message",
      params: {
        input: {
          content: [{ type: "input_text", text: "continue" }],
          quoted_text: "unpause the game",
        },
      },
    }),
    undefined,
  );
});
