import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";

import { ChatGptPlanAuth } from "./chatgpt-plan-auth.js";
import type { AiDmLocalSessionProof } from "./foundry-session.js";

const temporaryDirectories: string[] = [];

void afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function identity(isGm: boolean, userId = isGm ? "gm-1" : "player-1"): AiDmAuthenticatedIdentity {
  return {
    clientId: "client-1",
    userId,
    lane: isGm ? "gm" : "player",
    worldId: "world-1",
    isGm,
  };
}

function proof(principal = identity(true)): AiDmLocalSessionProof {
  return {
    sessionHash: `hash-${principal.userId}`,
    generation: 1,
    identity: principal,
    clientId: principal.clientId,
    browserSessionId: `browser-${principal.userId}`,
    moduleVersion: "0.1.0",
    expiresAt: "2026-09-30T00:00:00.000Z",
  };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function formBody(init: RequestInit | undefined): URLSearchParams {
  assert.ok(init?.body instanceof URLSearchParams);
  return init.body;
}

void describe("ChatGPT plan authorization", () => {
  void it("uses the pending registered client on reauthorization and rejects changed IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-reauthorization-"));
    temporaryDirectories.push(directory);
    let exchanges = 0;
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      fetch: (_input, init) => {
        exchanges++;
        assert.equal(formBody(init).get("client_id"), "issued-client");
        return Promise.resolve(
          Response.json({
            access_token: "access",
            refresh_token: "refresh",
            id_token: "identity",
            expires_in: 3600,
            scope: "openid profile email offline_access",
            client_id: "issued-client",
          }),
        );
      },
      idTokenVerifier: () => Promise.resolve({ email: "gm@example.test" }),
    });
    await auth.initialize();
    let url = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await assert.rejects(auth.complete("code", url.searchParams.get("state")!), /issued client ID/);
    url = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("code", url.searchParams.get("state")!, "issued-client");
    url = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    assert.equal(url.searchParams.get("client_id"), "issued-client");
    assert.equal(url.searchParams.has("agent_name_hint"), false);
    await auth.complete("code", url.searchParams.get("state")!);
    assert.equal(exchanges, 2);
    url = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await assert.rejects(
      auth.complete("code", url.searchParams.get("state")!, "other-client"),
      /does not match/,
    );
    assert.equal(exchanges, 2);
  });
  void it("creates a GM-only PKCE request and encrypts its local session file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-auth-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "auth.json");
    const auth = new ChatGptPlanAuth({
      path,
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
    });
    await auth.initialize();

    assert.throws(
      () => auth.begin(identity(false), proof(identity(false))),
      /Only a connected world GM/,
    );
    const { authorizationUrl } = auth.begin(identity(true), proof());
    const url = new URL(authorizationUrl);
    assert.equal(url.origin, "https://auth.openai.com");
    assert.equal(url.pathname, "/api/accounts/authorize");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:3940/auth/callback");
    assert.match(url.searchParams.get("scope") ?? "", /chatgpt\.tokens\.use\.direct/);
    assert.ok(url.searchParams.get("state"));
    assert.ok(url.searchParams.get("nonce"));

    const persisted = await readFile(path, "utf8");
    assert.doesNotMatch(persisted, /world-1|gm-1|accessToken|refreshToken/);
  });

  void it("keeps identity-only authorization encrypted and disables inference without plan scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-auth-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "auth.json");
    const auth = new ChatGptPlanAuth({
      path,
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      fetch: (_input, init) => {
        const body = formBody(init);
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.ok(body.get("code_verifier"));
        return Promise.resolve(
          Response.json({
            access_token: "identity-access-secret",
            refresh_token: "identity-refresh-secret",
            id_token: "identity-token",
            expires_in: 3600,
            scope: "openid profile email offline_access",
            client_id: "issued-client",
          }),
        );
      },
      idTokenVerifier: (token, audience, nonce) => {
        assert.equal(token, "identity-token");
        assert.equal(audience, "issued-client");
        assert.ok(nonce);
        return Promise.resolve({ email: "gm@example.test" });
      },
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");

    assert.deepEqual(auth.status("world-1", "gm-1"), {
      state: "connected",
      identityConnected: true,
      planUsageAuthorized: false,
      modelDiscoveryState: "not-authorized",
      gmUserId: "gm-1",
      email: "gm@example.test",
      expiresAt: auth.status("world-1", "gm-1").expiresAt,
      availableModels: [],
      selectedModel: null,
    });
    await assert.rejects(auth.accessToken("world-1"), /plan usage is not authorized/);
    const persisted = await readFile(path, "utf8");
    assert.doesNotMatch(
      persisted,
      /identity-access-secret|identity-refresh-secret|gm@example\.test/,
    );
  });

  void it("discovers safe models, selects deterministically, persists selection, and enforces owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-auth-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "auth.json");
    let modelRequests = 0;
    const fetcher: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      if (url === "https://api.openai.com/v1/models") {
        modelRequests += 1;
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "error");
        assert.deepEqual([...new Headers(init?.headers).keys()], ["authorization"]);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-secret");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [
                { slug: "gpt-z", display_name: "GPT Z", visibility: "list" },
                {
                  slug: "gpt-hidden",
                  display_name: "GPT Hidden",
                  visibility: "hide",
                  base_instructions: "x".repeat(360_000),
                },
                { slug: "gpt-a", display_name: "GPT A", visibility: "list" },
                { slug: "gpt-z", display_name: "Duplicate GPT Z", visibility: "list" },
              ],
            }),
            { headers: { "content-type": "application/vnd.openai.models+json" } },
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          id_token: "identity-token",
          expires_in: 3600,
          scope: "openid chatgpt.tokens.use.direct",
          client_id: formBody(init).get("client_id"),
        }),
      );
    };
    const create = () =>
      new ChatGptPlanAuth({
        path,
        redirectUri: "http://127.0.0.1:3940/auth/callback",
        encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
        validateLocalSessionProof: (value) => value,
        fetch: fetcher,
        idTokenVerifier: () => Promise.resolve({ email: "gm@example.test" }),
      });
    const auth = create();
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");

    const initial = await auth.statusWithModels(identity(true), "configured-unavailable");
    assert.deepEqual(initial.availableModels, [
      { slug: "gpt-z", displayName: "GPT Z" },
      { slug: "gpt-a", displayName: "GPT A" },
    ]);
    assert.equal(initial.modelDiscoveryState, "available");
    assert.equal(initial.selectedModel, null);
    await Promise.all([
      auth.selectModel(identity(true), "gpt-z", "configured-unavailable"),
      auth.selectModel(identity(true), "gpt-a", "configured-unavailable"),
    ]);
    assert.equal(auth.status("world-1", "gm-1").selectedModel, "gpt-a");
    assert.equal((await auth.resolveModel("world-1", "gpt-z")).model, "gpt-a");
    await assert.rejects(
      auth.selectModel(identity(true), "gpt-malicious", "configured-unavailable"),
      /not available/,
    );
    await assert.rejects(
      auth.selectModel(identity(true, "gm-2"), "gpt-z", "configured-unavailable"),
      /GM who connected ChatGPT/,
    );
    await assert.rejects(
      auth.selectModel(identity(false), "gpt-z", "configured-unavailable"),
      /connected world GM/,
    );
    await assert.rejects(
      auth.selectModel(
        { ...identity(true), worldId: "world-2" },
        "gpt-z",
        "configured-unavailable",
      ),
      /GM who connected ChatGPT/,
    );
    assert.equal(modelRequests, 1);

    const reloaded = create();
    await reloaded.initialize();
    assert.equal(
      (await reloaded.statusWithModels(identity(true), "configured-unavailable")).selectedModel,
      "gpt-a",
    );
    assert.equal(modelRequests, 2);
    await reloaded.signOut(identity(true));
    assert.deepEqual(reloaded.status("world-1", "gm-1").availableModels, []);
    const secondGm = identity(true, "gm-2");
    const switched = new URL(reloaded.begin(secondGm, proof(secondGm)).authorizationUrl);
    await reloaded.complete(
      "authorization-code-2",
      switched.searchParams.get("state")!,
      "issued-client-2",
    );
    assert.equal(
      (await reloaded.statusWithModels(secondGm, "configured-unavailable")).selectedModel,
      null,
    );
    assert.equal(modelRequests, 3);
  });

  void it("accepts an empty catalog for status but blocks inference until explicit selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-empty-models-"));
    temporaryDirectories.push(directory);
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      fetch: (input) =>
        requestUrl(input) === "https://api.openai.com/v1/models"
          ? Promise.resolve(
              new Response(JSON.stringify({ models: [] }), {
                headers: { "content-type": "application/json; charset=utf-8" },
              }),
            )
          : Promise.resolve(
              Response.json({
                access_token: "access-empty",
                refresh_token: "refresh-empty",
                id_token: "identity-token",
                expires_in: 3600,
                scope: "openid chatgpt.tokens.use.direct",
                client_id: "issued-client",
              }),
            ),
      idTokenVerifier: () => Promise.resolve({}),
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");
    const status = await auth.statusWithModels(identity(true), "configured-model");
    assert.deepEqual(status.availableModels, []);
    assert.equal(status.modelDiscoveryState, "empty");
    assert.equal(status.selectedModel, null);
    await assert.rejects(
      auth.resolveModel("world-1", "configured-model"),
      /No eligible ChatGPT model is selected/,
    );
  });

  void it("coalesces concurrent cold-cache status discovery into one models GET", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-concurrent-models-"));
    temporaryDirectories.push(directory);
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    let modelRequests = 0;
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      fetch: async (input) => {
        if (requestUrl(input) === "https://api.openai.com/v1/models") {
          modelRequests += 1;
          await discoveryGate;
          return Response.json({
            models: [
              { slug: "gpt-configured", display_name: "Configured GPT", visibility: "list" },
            ],
          });
        }
        return Response.json({
          access_token: "access-concurrent",
          refresh_token: "refresh-concurrent",
          id_token: "identity-token",
          expires_in: 3600,
          scope: "openid chatgpt.tokens.use.direct",
          client_id: "issued-client",
        });
      },
      idTokenVerifier: () => Promise.resolve({}),
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");

    const first = auth.statusWithModels(identity(true), "gpt-configured");
    const second = auth.statusWithModels(identity(true), "gpt-configured");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(modelRequests, 1);
    releaseDiscovery();
    const statuses = await Promise.all([first, second]);
    assert.deepEqual(
      statuses.map(({ selectedModel }) => selectedModel),
      ["gpt-configured", "gpt-configured"],
    );
    assert.equal(modelRequests, 1);
  });

  void it("fails closed for HTTP, auth, malformed, redirect, and timeout model discovery", async () => {
    const cases: Array<{ name: string; modelFetch: typeof fetch; pattern: RegExp }> = [
      {
        name: "auth",
        modelFetch: () => Promise.resolve(new Response(null, { status: 401 })),
        pattern: /authorization was rejected/,
      },
      {
        name: "forbidden",
        modelFetch: () => Promise.resolve(new Response(null, { status: 403 })),
        pattern: /authorization was rejected/,
      },
      {
        name: "rate-limit",
        modelFetch: () => Promise.resolve(new Response(null, { status: 429 })),
        pattern: /temporarily unavailable/,
      },
      {
        name: "transient",
        modelFetch: () => Promise.resolve(new Response(null, { status: 503 })),
        pattern: /temporarily unavailable/,
      },
      {
        name: "malformed",
        modelFetch: () =>
          Promise.resolve(
            Response.json({
              models: [{ slug: "gpt-test", display_name: "GPT Test" }],
            }),
          ),
        pattern: /invalid response/,
      },
      {
        name: "missing",
        modelFetch: () => Promise.resolve(Response.json({})),
        pattern: /invalid response/,
      },
      {
        name: "generic-data-envelope",
        modelFetch: () => Promise.resolve(Response.json({ data: [{ id: "gpt-test" }] })),
        pattern: /invalid response/,
      },
      {
        name: "wrong-content-type",
        modelFetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }],
              }),
              { headers: { "content-type": "text/plain" } },
            ),
          ),
        pattern: /invalid response/,
      },
      {
        name: "missing-content-type",
        modelFetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }],
              }),
            ),
          ),
        pattern: /invalid response/,
      },
      {
        name: "oversize",
        modelFetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                models: [
                  {
                    slug: `gpt-${"x".repeat(1_100_000)}`,
                    display_name: "Oversize",
                    visibility: "list",
                  },
                ],
              }),
              { headers: { "content-type": "application/json" } },
            ),
          ),
        pattern: /invalid response/,
      },
      {
        name: "redirect",
        modelFetch: (_input, init) => {
          assert.equal(init?.redirect, "error");
          return Promise.reject(new TypeError("redirect blocked"));
        },
        pattern: /temporarily unavailable/,
      },
      {
        name: "timeout",
        modelFetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            const guard = setTimeout(() => reject(new Error("timeout fixture guard")), 1_000);
            init?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(guard);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
        pattern: /temporarily unavailable/,
      },
      {
        name: "token-secrecy",
        modelFetch: () => Promise.reject(new Error("access-token-leak-sentinel")),
        pattern: /temporarily unavailable/,
      },
    ];
    for (const item of cases) {
      const directory = await mkdtemp(join(tmpdir(), `ai-dm-model-${item.name}-`));
      temporaryDirectories.push(directory);
      const auth = new ChatGptPlanAuth({
        path: join(directory, "auth.json"),
        redirectUri: "http://127.0.0.1:3940/auth/callback",
        encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
        validateLocalSessionProof: (value) => value,
        modelDiscoveryTimeoutMs: item.name === "timeout" ? 5 : 1_000,
        fetch: (input, init) =>
          requestUrl(input) === "https://api.openai.com/v1/models"
            ? item.modelFetch(input, init)
            : Promise.resolve(
                Response.json({
                  access_token: `access-${item.name}`,
                  refresh_token: `refresh-${item.name}`,
                  id_token: "identity-token",
                  expires_in: 3600,
                  scope: "openid chatgpt.tokens.use.direct",
                  client_id: "issued-client",
                }),
              ),
        idTokenVerifier: () => Promise.resolve({}),
      });
      await auth.initialize();
      const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
      await auth.complete(
        "authorization-code",
        started.searchParams.get("state")!,
        "issued-client",
      );
      const status = await auth.statusWithModels(identity(true), "gpt-test");
      const reconnectRequired = item.name === "auth" || item.name === "forbidden";
      assert.deepEqual(status.availableModels, []);
      assert.equal(
        status.modelDiscoveryState,
        reconnectRequired ? "not-authorized" : "unavailable",
      );
      assert.equal(status.identityConnected, !reconnectRequired);
      assert.equal(status.selectedModel, null);
      await assert.rejects(auth.resolveModel("world-1", "gpt-test"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, reconnectRequired ? /has not connected/ : item.pattern);
        assert.doesNotMatch(error.message, /access-token-leak-sentinel|access-[\w-]+/);
        return true;
      });
    }
  });

  void it("clears the model cache when OAuth access tokens rotate and never calls inference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-auth-"));
    temporaryDirectories.push(directory);
    let clock = Date.parse("2026-09-29T00:00:00.000Z");
    let modelRequests = 0;
    let refreshes = 0;
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      now: () => clock,
      fetch: (input, init) => {
        const url = requestUrl(input);
        if (url === "https://api.openai.com/v1/models") {
          modelRequests += 1;
          assert.match(new Headers(init?.headers).get("authorization") ?? "", /initial|rotated/);
          return Promise.resolve(
            Response.json({
              models: [{ slug: "gpt-visible", display_name: "GPT Visible", visibility: "list" }],
            }),
          );
        }
        const body = formBody(init);
        if (body.get("grant_type") === "refresh_token") {
          refreshes += 1;
          return Promise.resolve(
            Response.json({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
              scope: "openid chatgpt.tokens.use.direct",
            }),
          );
        }
        assert.notEqual(url, "https://api.openai.com/v1/responses");
        return Promise.resolve(
          Response.json({
            access_token: "initial-access",
            refresh_token: "initial-refresh",
            id_token: "identity-token",
            expires_in: 61,
            scope: "openid chatgpt.tokens.use.direct",
            client_id: "issued-client",
          }),
        );
      },
      idTokenVerifier: () => Promise.resolve({}),
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");
    assert.equal((await auth.resolveModel("world-1", "gpt-visible")).model, "gpt-visible");
    clock += 2_000;
    const rotated = await auth.resolveModel("world-1", "gpt-visible");
    assert.equal(rotated.model, "gpt-visible");
    assert.equal(refreshes, 1);
    assert.equal(modelRequests, 2);
    await auth.invalidate("world-1", "0".repeat(64));
    assert.equal(auth.providerState("world-1"), "eligible");
    await auth.invalidate("world-1", rotated.authorizationId);
    assert.equal(auth.providerState("world-1"), "blocked");
  });

  void it("clears stale ready status when model rediscovery becomes transiently unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-stale-models-"));
    temporaryDirectories.push(directory);
    let clock = Date.parse("2026-09-29T00:00:00.000Z");
    let discoveryAvailable = true;
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      now: () => clock,
      fetch: (input) =>
        requestUrl(input) === "https://api.openai.com/v1/models"
          ? Promise.resolve(
              discoveryAvailable
                ? Response.json({
                    models: [{ slug: "gpt-ready", display_name: "GPT Ready", visibility: "list" }],
                  })
                : new Response(null, { status: 503 }),
            )
          : Promise.resolve(
              Response.json({
                access_token: "access-ready",
                refresh_token: "refresh-ready",
                id_token: "identity-token",
                expires_in: 3600,
                scope: "openid chatgpt.tokens.use.direct",
                client_id: "issued-client",
              }),
            ),
      idTokenVerifier: () => Promise.resolve({}),
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");
    assert.equal(
      (await auth.statusWithModels(identity(true), "gpt-ready")).selectedModel,
      "gpt-ready",
    );
    // More than the old 60-second boundary remains reusable without another GET.
    clock += 60_001;
    assert.equal((await auth.resolveModel("world-1", "gpt-ready")).model, "gpt-ready");
    discoveryAvailable = false;
    clock += 300_001;
    const degraded = await auth.statusWithModels(identity(true), "gpt-ready");
    assert.deepEqual(degraded.availableModels, []);
    assert.equal(degraded.modelDiscoveryState, "unavailable");
    assert.equal(degraded.selectedModel, null);
    await assert.rejects(auth.resolveModel("world-1", "gpt-ready"), /temporarily unavailable/);
  });

  void it("invalidates persisted readiness when model authorization is rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-rejected-models-"));
    temporaryDirectories.push(directory);
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      fetch: (input) =>
        requestUrl(input) === "https://api.openai.com/v1/models"
          ? Promise.resolve(Response.json({ error: { code: "invalid_token" } }, { status: 401 }))
          : Promise.resolve(
              Response.json({
                access_token: "access-rejected",
                refresh_token: "refresh-rejected",
                id_token: "identity-token",
                expires_in: 3600,
                scope: "openid chatgpt.tokens.use.direct",
                client_id: "issued-client",
              }),
            ),
      idTokenVerifier: () => Promise.resolve({}),
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");

    await assert.rejects(auth.resolveModel("world-1", "gpt-ready"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ChatGptReconnectRequiredError");
      assert.doesNotMatch(error.message, /access-rejected|refresh-rejected/);
      return true;
    });
    assert.equal(auth.providerState("world-1"), "blocked");
    assert.equal(auth.status("world-1", "gm-1").identityConnected, false);
    assert.equal(auth.status("world-1", "gm-1").selectedModel, null);
  });

  void it("invalidates authorization when refresh drops direct-plan scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-refresh-scope-"));
    temporaryDirectories.push(directory);
    let clock = Date.parse("2026-09-29T00:00:00.000Z");
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      now: () => clock,
      fetch: (input, init) => {
        if (requestUrl(input) === "https://api.openai.com/v1/models") {
          return Promise.resolve(
            Response.json({
              models: [{ slug: "gpt-ready", display_name: "GPT Ready", visibility: "list" }],
            }),
          );
        }
        if (formBody(init).get("grant_type") === "refresh_token") {
          return Promise.resolve(
            Response.json({
              access_token: "rotated-without-scope",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
              scope: "openid profile",
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            access_token: "initial-access",
            refresh_token: "initial-refresh",
            id_token: "identity-token",
            expires_in: 61,
            scope: "openid chatgpt.tokens.use.direct",
            client_id: "issued-client",
          }),
        );
      },
      idTokenVerifier: () => Promise.resolve({}),
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");
    assert.equal((await auth.resolveModel("world-1", "gpt-ready")).model, "gpt-ready");
    clock += 2_000;
    await assert.rejects(auth.resolveModel("world-1", "gpt-ready"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ChatGptReconnectRequiredError");
      return true;
    });
    assert.equal(auth.providerState("world-1"), "blocked");
  });

  void it("serializes refresh, rotates encrypted tokens, and reports sign-out revocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-auth-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "auth.json");
    let refreshes = 0;
    let revocations = 0;
    const auth = new ChatGptPlanAuth({
      path,
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      fetch: async (input, init) => {
        const url = requestUrl(input);
        if (url.endsWith("/.well-known/openid-configuration")) {
          return Response.json({
            issuer: "https://auth.openai.com",
            jwks_uri: "https://auth.openai.com/jwks",
            revocation_endpoint: "https://auth.openai.com/revoke",
          });
        }
        if (url.endsWith("/revoke")) {
          revocations += 1;
          return new Response(null, { status: 200 });
        }
        const body = formBody(init);
        if (body.get("grant_type") === "refresh_token") {
          refreshes += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return Response.json({
            access_token: "rotated-access-secret",
            refresh_token: "rotated-refresh-secret",
            expires_in: 3600,
            scope: "openid chatgpt.tokens.use.direct",
          });
        }
        return Response.json({
          access_token: "initial-access-secret",
          refresh_token: "initial-refresh-secret",
          id_token: "identity-token",
          expires_in: 1,
          scope: "openid chatgpt.tokens.use.direct",
          client_id: "issued-client",
        });
      },
      idTokenVerifier: () => Promise.resolve({ email: "gm@example.test" }),
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client");
    assert.equal(auth.status("world-1", "gm-1").planUsageAuthorized, true);
    assert.deepEqual(
      await Promise.all([auth.accessToken("world-1"), auth.accessToken("world-1")]),
      ["rotated-access-secret", "rotated-access-secret"],
    );
    assert.equal(refreshes, 1);
    const persisted = await readFile(path, "utf8");
    assert.doesNotMatch(persisted, /initial-|rotated-|gm@example\.test/);

    assert.deepEqual(await auth.signOut(identity(true)), { remoteRevocationConfirmed: true });
    assert.equal(revocations, 1);
    assert.equal(auth.status("world-1", "gm-1").state, "signed-out");
  });

  void it("rejects a callback when the initiating local session expired or was revoked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-auth-"));
    temporaryDirectories.push(directory);
    let localSessionValid = true;
    let tokenRequests = 0;
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => {
        if (!localSessionValid) throw new Error("Local session expired or was revoked.");
        return value;
      },
      fetch: () => {
        tokenRequests += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      },
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    localSessionValid = false;

    await assert.rejects(
      auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client"),
      /expired or was revoked/,
    );
    assert.equal(tokenRequests, 0);
    assert.equal(auth.status("world-1", "gm-1").state, "signed-out");
  });

  void it("does not persist OAuth tokens when the local session is revoked during exchange", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-auth-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "auth.json");
    let localSessionValid = true;
    const auth = new ChatGptPlanAuth({
      path,
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => {
        if (!localSessionValid) throw new Error("Local session was revoked during sign-in.");
        return value;
      },
      fetch: () => {
        localSessionValid = false;
        return Promise.resolve(
          Response.json({
            access_token: "never-persisted-access-secret",
            refresh_token: "never-persisted-refresh-secret",
            id_token: "identity-token",
            expires_in: 3600,
            scope: "openid chatgpt.tokens.use.direct",
            client_id: "issued-client",
          }),
        );
      },
      idTokenVerifier: () => Promise.resolve({ email: "gm@example.test" }),
    });
    await auth.initialize();
    const started = new URL(auth.begin(identity(true), proof()).authorizationUrl);

    await assert.rejects(
      auth.complete("authorization-code", started.searchParams.get("state")!, "issued-client"),
      /revoked during sign-in/,
    );
    assert.equal(auth.status("world-1", "gm-1").state, "signed-out");
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      /never-persisted-access-secret|never-persisted-refresh-secret/,
    );
  });

  void it("keeps OAuth ownership with the exact GM and reuses its registration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-dm-auth-"));
    temporaryDirectories.push(directory);
    const auth = new ChatGptPlanAuth({
      path: join(directory, "auth.json"),
      redirectUri: "http://127.0.0.1:3940/auth/callback",
      encryptionKey: "test-key-that-is-at-least-thirty-two-characters",
      validateLocalSessionProof: (value) => value,
      fetch: () =>
        Promise.resolve(
          Response.json({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            id_token: "identity-token",
            expires_in: 3600,
            scope: "openid chatgpt.tokens.use.direct",
            client_id: "issued-client",
          }),
        ),
      idTokenVerifier: () => Promise.resolve({ email: "gm@example.test" }),
    });
    await auth.initialize();
    const first = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    await auth.complete("authorization-code", first.searchParams.get("state")!, "issued-client");

    const secondGm = identity(true, "gm-2");
    assert.throws(() => auth.begin(secondGm, proof(secondGm)), /already connected by another GM/);
    assert.equal(auth.status("world-1", "gm-2").state, "signed-out");
    await assert.rejects(auth.signOut(secondGm), /Only the GM who connected ChatGPT/);
    assert.equal(auth.owner("world-1"), "gm-1");
    assert.equal(auth.status("world-1", "gm-1").state, "connected");

    const returning = new URL(auth.begin(identity(true), proof()).authorizationUrl);
    assert.equal(returning.searchParams.get("client_id"), "issued-client");
    assert.equal(returning.searchParams.has("agent_name_hint"), false);
  });
});
