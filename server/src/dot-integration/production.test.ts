import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request } from "express";
import { createDotLocalAuthentication, loadDotProductionSetup, type DotProductionDependencies } from "./production.js";

const syntheticKey = `fdot_${"A".repeat(43)}`;
const keyHash = createHash("sha256").update(syntheticKey).digest("hex");
const path = "C:\\synthetic-private\\dot-config.json";
const config = { version: 1, enabled: true, mode: "private-tunnel-single-user", owner: "single-account", controller: { worldId: "world", sceneId: "scene", clientId: "client", userId: "gm" }, privateDirectory: "C:\\synthetic-private", credentialSha256: keyHash };
void test("interrupted configuration marker refuses activation and revokes an already loaded setup", async t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-config-marker-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = JSON.stringify({ ...config, privateDirectory: root }), configPath = join(root, "dot-config.json");
  const setup = loadDotProductionSetup(configPath, dependencies(raw))!;
  assert.equal(setup.active(), true);
  writeFileSync(join(root, "configuration.lock"), '{"version":1,"recovery":"synthetic interrupted save"}');
  assert.equal(setup.active(), false);
  assert.equal(await setup.authenticate(req(), new AbortController().signal), null);
  assert.throws(() => loadDotProductionSetup(configPath, dependencies(raw)), /activation refused/);
});
function dependencies(raw = JSON.stringify(config)): DotProductionDependencies {
  return { gateway: { getVerifiedFoundryIdentity: () => ({ worldId: "world", userId: "gm", userName: "GM", role: 4, isGM: true }) }, administrativeCredentialSha256: "f".repeat(64), bindHost: "127.0.0.1", read: () => raw, verifier: () => () => undefined, codec: { seal: () => "synthetic", unseal: () => "synthetic" } };
}
function req(key: string | undefined = syntheticKey, overrides: Record<string, unknown> = {}): Request {
  return { method: "POST", path: "/dot/mcp", socket: { remoteAddress: "127.0.0.1" }, rawHeaders: key ? ["x-foundry-dot-key", key] : [], header: () => key, ...overrides } as unknown as Request;
}
void test("production loader stays disabled without configuration and never provisions anything", () => {
  let reads = 0;
  const deps = { ...dependencies(), read: () => { reads++; return '{"version":1,"enabled":false}'; }, verifier: () => { throw new Error("must remain unused"); } };
  assert.equal(loadDotProductionSetup(undefined, deps), undefined); assert.equal(reads, 0);
  assert.equal(loadDotProductionSetup(path, deps), undefined); assert.equal(reads, 1);
});
void test("production loader refuses invalid scope, shared admin key, unsafe host and failed ACL", () => {
  for (const value of [{ ...config, controller: { ...config.controller, worldId: "../world" } }, { ...config, mode: "public" }, { ...config, privateDirectory: "C:\\other" }, { ...config, extra: true }]) {
    assert.throws(() => loadDotProductionSetup(path, dependencies(JSON.stringify(value))), /activation refused/);
  }
  assert.throws(() => loadDotProductionSetup(path, { ...dependencies(), administrativeCredentialSha256: keyHash }), /activation refused/);
  assert.throws(() => loadDotProductionSetup(path, { ...dependencies(), bindHost: "0.0.0.0" }), /activation refused/);
  assert.throws(() => loadDotProductionSetup(path, { ...dependencies(), verifier: () => () => { throw new Error("synthetic private details"); } }), error => error instanceof Error && /activation refused/.test(error.message) && !error.message.includes("private details"));
  assert.throws(() => loadDotProductionSetup("relative.json", dependencies()), /activation refused/);
});
void test("dedicated loopback authentication maps one principal and rejects forged identity headers", async () => {
  const setup = loadDotProductionSetup(path, dependencies())!, signal = new AbortController().signal;
  assert.equal(await setup.authenticate(req(), signal), "single-account");
  assert.equal(await setup.authenticate(req(undefined, { rawHeaders: [] }), signal), null);
  assert.equal(await setup.authenticate(req(`fdot_${"B".repeat(43)}`), signal), null);
  assert.equal(await setup.authenticate(req(syntheticKey, { rawHeaders: ["x-foundry-dot-key", syntheticKey, "X-Foundry-Dot-Key", syntheticKey] }), signal), null);
  assert.equal(await setup.authenticate(req(syntheticKey, { socket: { remoteAddress: "192.0.2.4" }, rawHeaders: ["x-foundry-dot-key", syntheticKey, "X-Forwarded-For", "127.0.0.1"] }), signal), null);
  assert.equal(await setup.authenticate(req(syntheticKey, { method: "GET" }), signal), null);
  assert.equal(await setup.authenticate(req(syntheticKey, { path: "/mcp" }), signal), null);
  assert.equal(await setup.authenticate(req(syntheticKey, { rawHeaders: ["x-foundry-dot-key", syntheticKey, "x-owner", "someone-else"] }), signal), "single-account");
  assert.equal(await createDotLocalAuthentication(config as Parameters<typeof createDotLocalAuthentication>[0], () => false)(req(), signal), null);
  const canceled = new AbortController(); canceled.abort(); assert.equal(await setup.authenticate(req(), canceled.signal), null);
});
void test("dedicated scoped authentication works without an unrelated admin remediation marker and never accepts the admin credential", async t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-dot-isolation-synthetic-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const administrativeKey = "synthetic-administrative-key-never-used-by-dot", administrativeCredentialSha256 = createHash("sha256").update(administrativeKey).digest("hex");
  const raw = JSON.stringify({ ...config, privateDirectory: root });
  assert.equal(existsSync(join(root, ".managed-credential.required")), false);
  const setup = loadDotProductionSetup(join(root, "dot-config.json"), { ...dependencies(raw), administrativeCredentialSha256 })!;
  const signal = new AbortController().signal;
  assert.equal(await setup.authenticate(req(), signal), "single-account");
  for (const headers of [["x-api-key", administrativeKey], ["Authorization", `Bearer ${administrativeKey}`], ["x-foundry-dot-key", administrativeKey]]) {
    assert.equal(await setup.authenticate(req(administrativeKey, { rawHeaders: headers }), signal), null);
  }
  for (const target of ["/api", "/api/world", "/mcp", "/dot/mcp/../mcp", "/dot/mcp/extra"]) assert.equal(await setup.authenticate(req(syntheticKey, { path: target }), signal), null);
  assert.throws(() => loadDotProductionSetup(join(root, "dot-config.json"), { ...dependencies(raw), administrativeCredentialSha256: keyHash }), /activation refused/);
});
void test("activation and controller attestation revoke on config changes or verified world mismatch", async () => {
  let raw = JSON.stringify(config), worldId = "world";
  const setup = loadDotProductionSetup(path, { ...dependencies(), read: () => raw, gateway: { getVerifiedFoundryIdentity: () => ({ worldId, userId: "gm", userName: "GM", role: 4, isGM: true }) } })!;
  const binding = { ...config.controller, sessionId: "session", controllerId: "controller" }, client = { clientId: "client", userId: "gm", lane: "gm", isGM: true, capabilities: [] };
  assert.equal(await setup.verifyController(binding, client), true);
  assert.equal(await setup.verifyController({ ...binding, sceneId: "other" }, client), false);
  assert.equal(await setup.verifyController(binding, { ...client, clientId: "other" }), false);
  worldId = "other"; assert.equal(await setup.verifyController(binding, client), false); worldId = "world";
  raw += " "; assert.equal(setup.active(), false);
  assert.equal(await setup.authenticate(req(), new AbortController().signal), null);
});
