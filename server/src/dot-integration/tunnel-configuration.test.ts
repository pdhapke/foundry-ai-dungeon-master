/* Synthetic async mock adapters intentionally resolve synchronously. */
/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, writeSync, fsyncSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ProtectedTunnelConfigurationStorage, TunnelConfigurationService, type TunnelConfigurationStatus } from "./tunnel-configuration.js";
import { createWindowsPrivateStorageVerifier } from "./windows-security.js";

const scope = { worldId: "mcp-test", sceneId: "scene", clientId: "client", userId: "gm" };
const tunnelId = `tunnel_${"a".repeat(32)}`;
const synthetic = "synthetic-tunnel-runtime-key-for-tests";
void test("synchronous status and activation profile each batch ACL once, later reads/mutations reverify and recovery/revocation stays fresh", t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-dot-batch-synthetic-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  new ProtectedTunnelConfigurationStorage(root, () => undefined).save(scope, tunnelId, synthetic, false);
  let batches = 0, singles = 0, revoked = false;
  const verify = createWindowsPrivateStorageVerifier(root, (_script, input) => {
    const value = JSON.parse(input) as { paths?: string[]; path?: string };
    if (value.paths) { batches++; assert.equal(value.paths.length, 5); } else singles++;
    if (revoked) throw new Error("synthetic private failure must not appear"); return "private-storage-v1";
  });
  const storage = new ProtectedTunnelConfigurationStorage(root, verify);
  assert.equal(storage.status(scope).configured, true); assert.equal(batches, 1); assert.equal(singles, 0);
  storage.activationProfile(scope); assert.equal(batches, 2); assert.equal(singles, 0);
  storage.status(scope); assert.equal(batches, 3);
  writeFileSync(join(root, "configuration.lock"), "synthetic recovery"); assert.throws(() => storage.status(scope), /interrupted/); assert.equal(batches, 4);
  rmSync(join(root, "configuration.lock")); revoked = true;
  assert.throws(() => storage.activationProfile(scope), /operator setup/); assert.equal(batches, 5);
  assert.throws(() => storage.save(scope, tunnelId, undefined, false), /operator setup/); assert.equal(singles, 1);
  t.diagnostic(JSON.stringify({ component: "synthetic_status_profile_acl", previousStatusProcessStarts: 5, previousProfileProcessStarts: 9, currentStatusProcessStarts: 1, currentProfileProcessStarts: 1 }));
});
void test("profile and private UI inputs cannot select arbitrary upstreams or administrative paths", async t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-dot-upstream-synthetic-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new ProtectedTunnelConfigurationStorage(root, () => undefined); storage.save(scope, tunnelId, synthetic, false);
  const profilePath = join(root, "tunnel-profile.yaml"), supported = readFileSync(profilePath, "utf8");
  assert.equal(storage.activationProfile(scope), profilePath);
  for (const url of ["http://127.0.0.1:3939/mcp", "http://127.0.0.1:3939/api", "https://untrusted.example/mcp"]) {
    writeFileSync(profilePath, supported.replace("http://127.0.0.1:3939/dot/mcp", url));
    assert.throws(() => storage.activationProfile(scope), /profile differs/);
    assert.equal(readFileSync(profilePath, "utf8"), supported.replace("http://127.0.0.1:3939/dot/mcp", url));
  }
  writeFileSync(profilePath, supported);
  const replies: Record<string, unknown>[] = [];
  const service = new TunnelConfigurationService(storage,
    { getVerifiedFoundryIdentity: () => ({ worldId: scope.worldId, userId: scope.userId, userName: "GM", role: 4, isGM: true }), send: raw => { replies.push(JSON.parse(raw) as Record<string, unknown>); return true; } }, async () => scope);
  for (const field of ["serverUrl", "upstream", "path", "profilePath"]) {
    await service.handle({ kind: "dot-tunnel-configuration", requestId: randomUUID(), worldId: scope.worldId, action: "save", tunnelId, expectedController: scope, [field]: "/mcp" }, { clientId: scope.clientId, userId: scope.userId, lane: "gm" }, () => true);
    assert.equal(replies.at(-1)!["errorCode"], "invalid_input");
  }
  assert.equal(readFileSync(profilePath, "utf8"), supported);
});
void test("protected save creates dedicated files, no plaintext in config/profile, explicit key rotation and scope lock", t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-config-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checked: string[] = []; const store = new ProtectedTunnelConfigurationStorage(root, path => { checked.push(path); });
  assert.equal(store.status(scope).configured, false);
  store.save(scope, tunnelId, synthetic, false);
  const status = store.status(scope); assert.equal(status.configured, true); assert.equal(status.activation, "inactive");
  const key = readFileSync(join(root, "dot-key.txt")); const config = JSON.parse(readFileSync(join(root, "dot-config.json"), "utf8")) as { credentialSha256: string };
  assert.ok(config.credentialSha256 === createHash("sha256").update(key).digest("hex"));
  const profile = readFileSync(join(root, "tunnel-profile.yaml"), "utf8");
  assert.ok(!profile.includes(synthetic) && !JSON.stringify(config).includes(synthetic));
  assert.ok(profile.includes("http://127.0.0.1:3939/dot/mcp") && profile.includes("file:"));
  assert.throws(() => store.save(scope, tunnelId, synthetic + "-changed", false), /already saved/);
  store.save(scope, tunnelId, undefined, false);
  assert.ok(readFileSync(join(root, "dot-key.txt")).equals(key));
  store.save(scope, tunnelId, synthetic + "-changed", true);
  assert.throws(() => store.save({ ...scope, sceneId: "different" }, tunnelId, undefined, false), /another GM, scene, or browser/);
  writeFileSync(join(root, "dot-events.json"), "{}");
  assert.throws(() => store.save(scope, tunnelId, undefined, false), /event state/);
  assert.equal(existsSync(join(root, "configuration.lock")), false); assert.ok(checked.length > 10);
});

void test("service and protected storage return exact safe failures and confirmed persisted status", async t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-config-service-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const replies: Record<string, unknown>[] = [];
  const gateway = { getVerifiedFoundryIdentity: () => ({ worldId: "mcp-test", userId: "gm", userName: "GM", role: 4, isGM: true }), send: (raw: string) => { replies.push(JSON.parse(raw) as Record<string, unknown>); return true; } };
  const service = new TunnelConfigurationService(new ProtectedTunnelConfigurationStorage(root, () => undefined), gateway, async () => scope);
  const request = (extra: Record<string, unknown> = {}) => ({ kind: "dot-tunnel-configuration", requestId: randomUUID(), worldId: "mcp-test", action: "save", tunnelId, expectedController: scope, ...extra });
  const send = async (raw: Record<string, unknown>) => { await service.handle(raw, { clientId: "client", userId: "gm", lane: "gm" }, () => true); assert.ok(!Object.hasOwn(raw, "runtimeKey")); return replies.at(-1)!; };
  assert.equal((await send(request())).errorCode, "runtime_key_required");
  assert.equal((await send(request({ runtimeKey: synthetic + "\n" }))).errorCode, "invalid_input");
  assert.equal(existsSync(join(root, "runtime-key.txt")), false);
  const saved = await send(request({ runtimeKey: synthetic })); assert.equal((saved.status as TunnelConfigurationStatus).configured, true);
  assert.equal((await send(request({ runtimeKey: synthetic + "-new" }))).errorCode, "replacement_required");
  assert.equal(readFileSync(join(root, "runtime-key.txt"), "utf8"), synthetic);
  assert.equal((await send(request({ expectedController: { ...scope, sceneId: "stale" } }))).errorCode, "scope_changed");
  assert.ok(!JSON.stringify(replies).includes(synthetic));
  const count = replies.length;
  await service.handle(request({ runtimeKey: "invalid" }), { clientId: "client", userId: "gm", lane: "player" }, () => true);
  assert.equal(replies.length, count);
  const noScene = new TunnelConfigurationService(new ProtectedTunnelConfigurationStorage(root, () => undefined), gateway, async () => { throw new Error("synthetic-unavailable-scene"); });
  await noScene.handle(request(), { clientId: "client", userId: "gm", lane: "gm" }, () => true);
  assert.equal(replies.at(-1)!.errorCode, "scope_unavailable");
});

void test("CRLF manual profile of the supported shape can be preserved on first Save", t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-config-profile-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProtectedTunnelConfigurationStorage(root, () => undefined);
  store.save(scope, tunnelId, synthetic, false);
  const path = join(root, "tunnel-profile.yaml"); writeFileSync(path, readFileSync(path, "utf8").replaceAll("\n", "\r\n"));
  assert.equal(store.status(scope).configured, true);
  store.save(scope, tunnelId, undefined, false);
  assert.equal(readFileSync(join(root, "runtime-key.txt"), "utf8"), synthetic);
});
void test("unsafe storage and unknown profile remain unchanged; existing raw key is never silently overwritten", t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-config-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "tunnel-profile.yaml"), "operator-owned-unexpected-profile");
  const store = new ProtectedTunnelConfigurationStorage(root, () => undefined);
  assert.throws(() => store.save(scope, tunnelId, synthetic, false), /existing tunnel profile/);
  assert.equal(existsSync(join(root, "dot-key.txt")), false);
  assert.ok(readFileSync(join(root, "tunnel-profile.yaml"), "utf8") === "operator-owned-unexpected-profile");
  const unsafe = new ProtectedTunnelConfigurationStorage(root, () => { throw new Error("synthetic-permission-denial"); });
  assert.throws(() => unsafe.status(scope));
});
void test("service independently verifies local GM/world, rejects scope change/revocation, scrubs keys and replies without secrets", async () => {
  let live = true, reads = 0, saves = 0;
  const replies: Record<string, unknown>[] = [];
  const status: TunnelConfigurationStatus = { configured: false, runtimeKeyConfigured: false, bridgeKeyConfigured: false, controller: scope, activation: "inactive", message: "Separate activation required." };
  const store = { status: () => status, save: () => { saves++; } };
  const gateway = { getVerifiedFoundryIdentity: () => live ? { worldId: "mcp-test", userId: "gm", userName: "GM", role: 4, isGM: true } : null,
    send: (raw: string) => { replies.push(JSON.parse(raw) as Record<string, unknown>); return true; } };
  const service = new TunnelConfigurationService(store, gateway, async () => { reads++; return scope; });
  const input = () => ({ kind: "dot-tunnel-configuration", requestId: randomUUID(), worldId: "mcp-test", action: "save", tunnelId, expectedController: scope, runtimeKey: synthetic });
  const raw = input(); await service.handle(raw, { clientId: "client", userId: "gm", lane: "gm" }, () => true);
  assert.equal(saves, 1); assert.equal(reads, 2); assert.ok(!Object.hasOwn(raw, "runtimeKey")); assert.ok(!JSON.stringify(replies).includes(synthetic));
  await service.handle(input(), { clientId: "client", userId: "gm", lane: "player" }, () => true);
  await service.handle({ ...input(), worldId: "campaign" }, { clientId: "client", userId: "gm", lane: "gm" }, () => true);
  live = false; await service.handle(input(), { clientId: "client", userId: "gm", lane: "gm" }, () => true); assert.equal(saves, 1);
  live = true;
  await service.handle({ ...input(), expectedController: { ...scope, sceneId: "old-displayed-scene" } }, { clientId: "client", userId: "gm", lane: "gm" }, () => true); assert.equal(saves, 1);
  const active = new TunnelConfigurationService(store, gateway, async () => scope, "mcp-test", () => true);
  await active.handle(input(), { clientId: "client", userId: "gm", lane: "gm" }, () => true); assert.equal(saves, 1);
  let read = 0;
  const stale = new TunnelConfigurationService(store, gateway, async () => ++read === 1 ? scope : { ...scope, sceneId: "changed" });
  await stale.handle(input(), { clientId: "client", userId: "gm", lane: "gm" }, () => true); assert.equal(saves, 1);
  const revoked = new TunnelConfigurationService(store, gateway, async () => { live = false; return scope; });
  await revoked.handle(input(), { clientId: "client", userId: "gm", lane: "gm" }, () => true); assert.equal(saves, 1);
});
void test("write, flush and rename failures clean only their exact temporary file without leaving secret staging files", t => {
  for (const stage of ["write", "flush", "rename", "short"]) {
    const root = mkdtempSync(join(tmpdir(), "foundry-config-fault-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new ProtectedTunnelConfigurationStorage(root, () => undefined, {
      write: (fd, bytes) => { writeSync(fd, stage === "short" ? bytes.subarray(0, 1) : bytes); if (stage === "write") throw new Error("synthetic-write-failure"); },
      flush: fd => { if (stage === "flush") throw new Error("synthetic-flush-failure"); fsyncSync(fd); },
      rename: (from, to) => { if (stage === "rename") throw new Error("synthetic-rename-failure"); renameSync(from, to); },
    });
    assert.throws(() => store.save(scope, tunnelId, synthetic, false), /save did not complete/);
    assert.deepEqual(readdirSync(root), ["configuration.lock"]);
    assert.throws(() => store.status(scope), /interrupted configuration save/);
    assert.throws(() => store.save(scope, tunnelId, synthetic, false));
    assert.ok(!readFileSync(join(root, "configuration.lock"), "utf8").includes(synthetic));
  }
});
void test("every partial commit boundary preserves a nonsecret recovery marker and blocks status and retry", t => {
  for (const failureAt of [2, 3, 4]) {
    const root = mkdtempSync(join(tmpdir(), "foundry-config-commit-fault-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    let commits = 0;
    const store = new ProtectedTunnelConfigurationStorage(root, () => undefined, { write: (fd, bytes) => { writeSync(fd, bytes); }, flush: fsyncSync,
      rename: (from, to) => { if (++commits === failureAt) throw new Error("synthetic-commit-failure"); renameSync(from, to); } });
    assert.throws(() => store.save(scope, tunnelId, synthetic, false), /save did not complete/);
    assert.ok(existsSync(join(root, "configuration.lock")));
    assert.ok(!readdirSync(root).some(name => name.endsWith(".tmp")));
    assert.throws(() => store.status(scope), /interrupted configuration save/);
    assert.throws(() => store.save(scope, tunnelId, undefined, false));
  }
});
void test("partial runtime-key rotation preserves a recovery marker instead of presenting the old config as successful", t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-config-rotation-fault-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  new ProtectedTunnelConfigurationStorage(root, () => undefined).save(scope, tunnelId, synthetic, false);
  let commits = 0;
  const store = new ProtectedTunnelConfigurationStorage(root, () => undefined, { write: (fd, bytes) => { writeSync(fd, bytes); }, flush: fsyncSync,
    rename: (from, to) => { if (++commits === 2) throw new Error("synthetic-profile-commit-failure"); renameSync(from, to); } });
  assert.throws(() => store.save(scope, tunnelId, synthetic + "-new", true), /save did not complete/);
  assert.ok(existsSync(join(root, "dot-config.json")) && existsSync(join(root, "configuration.lock")));
  assert.throws(() => store.status(scope), /interrupted configuration save/);
  assert.ok(!readdirSync(root).some(name => name.endsWith(".tmp")));
});
