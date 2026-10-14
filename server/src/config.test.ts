import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { AiDmConfigError, assertPrivateChatkitPath, loadAiDmServerConfig, parseAcceptanceFixtures } from "./config.js";

void describe("AI Dungeon Master server configuration", () => {
  void it("keeps private conversation outside served Data and rejects junction bypasses", () => {
    const config = loadAiDmServerConfig({ NODE_ENV: "test" });
    assert.match(config.chatkitDatabasePath, /[\\/]\.runtime[\\/]foundry-ai-dungeon-master[\\/]chatkit.sqlite$/);
    assert.throws(() => loadAiDmServerConfig({ NODE_ENV: "test", AI_DM_CHATKIT_DATABASE_PATH: resolve(config.worldsRoot, "private.sqlite") }), /publicly served/);
    const root = mkdtempSync(join(tmpdir(), "prompt1-storage-"));
    try {
      const served = join(root, "Data");
      mkdirSync(served);
      assert.throws(() => assertPrivateChatkitPath(join(served, "nested", "private.sqlite"), [served]), /publicly served/);
      assert.equal(assertPrivateChatkitPath(join(root, "safe", "private.sqlite"), [served]), join(root, "safe", "private.sqlite"));
      const alias = join(root, "alias");
      symlinkSync(served, alias, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => assertPrivateChatkitPath(join(alias, "new", "private.sqlite"), [served]), /publicly served/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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

void it("protects per-world campaign root with default outside Data and no public override", () => {
  const config = loadAiDmServerConfig({ NODE_ENV: "test" });
  assert.equal(config.campaignProtectedRoot, resolve(config.chatkitDatabasePath, "..", "campaign-worlds"));
  assert.throws(() => loadAiDmServerConfig({ NODE_ENV: "test", AI_DM_CAMPAIGN_PROTECTED_ROOT: resolve(config.worldsRoot, "secret") }), /publicly served/);
});
void it("fixture budgets are immutable startup-only scoped configuration", () => {
  const now = Date.now();
  const fixture = { worldId: "w", userId: "u", threadId: "t", traceId: "12345678-1234-1234-1234-123456789abc", maxModelRequests: 2, expiresAt: new Date(now + 10000).toISOString() };
  const parsed = parseAcceptanceFixtures(JSON.stringify({ acceptance: fixture }), now);
  assert.equal(parsed["acceptance"]!.maxModelRequests, 2); assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed["acceptance"]));
  assert.equal(parseAcceptanceFixtures(JSON.stringify({forest:{...fixture,maxModelRequests:6}}),now)['forest']!.maxModelRequests,6);
  assert.throws(()=>parseAcceptanceFixtures(JSON.stringify({forest:{...fixture,maxModelRequests:7}}),now),/Invalid acceptance/);
  assert.deepEqual(parseAcceptanceFixtures(undefined), {});
  for (const changed of [{ maxModelRequests: 15 }, { worldId: "../other" }, { expiresAt: new Date(now - 1).toISOString() }, { expiresAt: new Date(now + 86400001).toISOString() }, { unknown: true }])
    assert.throws(() => parseAcceptanceFixtures(JSON.stringify({ acceptance: { ...fixture, ...changed } }), now), /Invalid acceptance/);
});
