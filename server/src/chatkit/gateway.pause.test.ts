import assert from "node:assert/strict";
import { it } from "node:test";
import request from "supertest";
import { createAiDmApp } from "../app.js";
import { createChatKitGateway } from "./gateway.js";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";
import type { SessionRequestAuthorization } from "./pause-request.js";

void it("binds pause authority only to the authenticated current GM's direct input", async () => {
  const observed: Array<SessionRequestAuthorization | undefined> = [];
  const identity = { worldId: "world", userId: "gm", isGm: true } as AiDmAuthenticatedIdentity;
  const app = createAiDmApp({
    readiness: () => ({ ready: true, details: {} }),
    chatkitHandler: createChatKitGateway({
      sidecarUrl: "http://127.0.0.1:3941",
      internalSecret: "fixture-only",
      allowedOrigins: [],
      authenticate: () => identity,
      authorize: () => Promise.resolve(),
      resolveAuthorization: () => Promise.resolve({ apiKey: "fixture-only", model: "fixture" }),
      beginReadRun: (_identity, _body, _signal, desired) => {
        observed.push(desired);
        return { token: "fixture-capability", release: () => {} };
      },
      fetch: () => Promise.resolve(new Response("", { status: 200 })),
    }),
  });
  const input = (text: string) => ({
    type: "threads.add_user_message",
    params: {
      thread_id: "thread",
      input: { content: [{ type: "input_text", text }], attachments: [], inference_options: {} },
    },
  });
  for (const text of [
    "please unpause the game",
    "please pause the game",
    'The NPC says "please unpause the game"',
    "Do not unpause the game",
    "Describe the room",
  ])
    assert.equal((await request(app).post("/chatkit").send(input(text))).status, 200);
  assert.deepEqual(
    observed.map((value) => value?.paused),
    [false, true, undefined, undefined, undefined],
  );
  assert.equal(observed[4]?.worldControl?.manualRequest, true);
  const action = {
    type: "threads.custom_action",
    params: {
      thread_id: "thread",
      action: {
        type: "foundry.context-response",
        payload: { requestId: "event", prompt: "please unpause the game", context: {} },
      },
    },
  };
  assert.equal((await request(app).post("/chatkit").send(action)).status, 200);
  assert.equal(observed.at(-1), undefined);
});
