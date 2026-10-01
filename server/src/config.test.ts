import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AiDmConfigError, loadAiDmServerConfig } from "./config.js";

void describe("AI Dungeon Master server configuration", () => {
  void it("is loopback-only and remains testable without live provider keys", () => {
    const config = loadAiDmServerConfig({ NODE_ENV: "test" });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.openAiApiKey, null);
    assert.equal(config.foundryLocalApiKey, null);
    assert.equal(config.foundryBrokerSecret, null);
    assert.equal(config.signingKeyEphemeral, true);
    assert.equal(config.openAiApiKeyFallbackEnabled, false);
    assert.equal(config.chatkitPort, 3941);
    assert.equal(config.chatkitAuth, "existing");
    assert.equal(
      loadAiDmServerConfig({ NODE_ENV: "test", AI_DM_CHATKIT_AUTH: "api-key" }).chatkitAuth,
      "api-key",
    );
    assert.throws(
      () => loadAiDmServerConfig({ NODE_ENV: "test", AI_DM_CHATKIT_AUTH: "invalid" }),
      AiDmConfigError,
    );
    assert.match(config.chatkitPython, /python(?:\.exe)?$/);
    assert.match(config.chatkitDatabasePath, /chatkit\.sqlite$/);
    assert.deepEqual(config.allowedFoundryOrigins, [
      "http://127.0.0.1:30000",
      "http://localhost:30000",
      "http://[::1]:30000",
    ]);
  });

  void it("rejects remote provider URLs and remote server binds", () => {
    assert.throws(
      () => loadAiDmServerConfig({ NODE_ENV: "test", AI_DM_CHATKIT_PORT: "0" }),
      AiDmConfigError,
    );
    assert.throws(
      () => loadAiDmServerConfig({ NODE_ENV: "test", AI_DM_HOST: "0.0.0.0" }),
      AiDmConfigError,
    );
    assert.throws(
      () =>
        loadAiDmServerConfig({
          NODE_ENV: "test",
          FOUNDRY_LOCAL_API_URL: "https://example.com",
        }),
      AiDmConfigError,
    );
  });

  void it("requires persistent signing and process-tree broker keys in production", () => {
    assert.throws(() => loadAiDmServerConfig({ NODE_ENV: "production" }), AiDmConfigError);
    const config = loadAiDmServerConfig({
      NODE_ENV: "production",
      AI_DM_SIGNING_KEY: "x".repeat(32),
      AI_DM_FOUNDRY_BROKER_SECRET: "b".repeat(32),
    });
    assert.equal(config.signingKeyEphemeral, false);
    assert.throws(
      () =>
        loadAiDmServerConfig({
          NODE_ENV: "production",
          AI_DM_SIGNING_KEY: "x".repeat(32),
        }),
      /FOUNDRY_BROKER_SECRET/,
    );
  });

  void it("keeps the API-key provider disabled unless fallback is explicitly enabled", () => {
    assert.equal(
      loadAiDmServerConfig({ NODE_ENV: "test", OPENAI_API_KEY: "k".repeat(32) }).openAiApiKey,
      null,
    );
    const enabled = loadAiDmServerConfig({
      NODE_ENV: "test",
      OPENAI_API_KEY: "k".repeat(32),
      AI_DM_ENABLE_API_KEY_FALLBACK: "true",
      AI_DM_FOUNDRY_ORIGINS: "http://127.0.0.1:31000",
    });
    assert.equal(enabled.openAiApiKey, "k".repeat(32));
    assert.equal(enabled.openAiApiKeyFallbackEnabled, true);
    assert.deepEqual(enabled.allowedFoundryOrigins, ["http://127.0.0.1:31000"]);
  });
});
