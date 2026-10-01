import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type { ChatGptPlanAuth } from "./auth/index.js";
import { createAiDmApp } from "./app.js";

void describe("AI Dungeon Master HTTP app", () => {
  void it("permits returning OAuth callbacks without a repeated client ID", async () => {
    let clientId: string | undefined = "not-called";
    const app = createAiDmApp({
      chatGptAuth: {
        complete: (_code: string, _state: string, value?: string) => {
          clientId = value;
          return Promise.resolve();
        },
      } as unknown as ChatGptPlanAuth,
      readiness: () => ({ ready: true, details: {} }),
    });
    assert.equal((await request(app).get("/auth/callback?code=code-1&state=state-1")).status, 200);
    assert.equal(clientId, undefined);
  });
  void it("does not expose operator enrollment and returns safe health", async () => {
    const app = createAiDmApp({
      readiness: () => ({ ready: true, details: { openAiConfigured: true } }),
    });
    const health = await request(app).get("/health");
    assert.equal(health.status, 200);
    assert.equal(JSON.stringify(health.body).includes("one-time-code"), false);
    assert.equal((await request(app).post("/operator/enrollments").send({})).status, 404);
  });

  void it("notifies only configured Foundry origins after an OAuth callback", async () => {
    const app = createAiDmApp({
      chatGptAuth: {
        complete: () => Promise.resolve(),
      } as unknown as ChatGptPlanAuth,
      callbackPostMessageOrigins: ["http://127.0.0.1:30000"],
      readiness: () => ({ ready: true, details: {} }),
    });
    const response = await request(app).get(
      "/auth/callback?code=code-1&state=state-1&client_id=client-1",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.match(response.text, /http:\/\/127\.0\.0\.1:30000/);
    assert.doesNotMatch(response.text, /postMessage\([^)]*,\s*["']\*["']/);
  });
});
