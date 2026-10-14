/* Synthetic async mock adapters intentionally resolve synchronously. */
/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { crc32, tunnelDigest, unpackTunnelRelease } from "./tunnel-archive.js";
import { allowedTunnelDownloadUrl, pinnedTunnelLookup } from "./tunnel-download.js";
import { TunnelToolInstaller } from "./tunnel-install.js";
import { AdoptingTunnelToolInstaller } from "./tool-adoption.js";
import { TunnelSetupService } from "./tunnel-setup.js";
import { TUNNEL_RELEASES, tunnelReleaseFiles, tunnelReleaseUrl, type TunnelRelease } from "./tunnel-release.js";

function zip(entries: { name: string; data: Buffer; attributes?: number; flags?: number; method?: number; localExtra?: Buffer; centralExtra?: Buffer; declaredSize?: number }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), method = entry.method ?? 8, compressed = method === 0 ? entry.data : deflateRawSync(entry.data), flags = entry.flags ?? 0, size = entry.declaredSize ?? entry.data.length, crc = crc32(entry.data), localExtra = entry.localExtra ?? Buffer.alloc(0), centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(localExtra.length, 28);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x314, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(flags, 8); header.writeUInt16LE(method, 10); header.writeUInt32LE(crc, 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(size, 24); header.writeUInt16LE(name.length, 28); header.writeUInt16LE(centralExtra.length, 30); header.writeUInt32LE(entry.attributes ?? ((0o100644 << 16) >>> 0), 38); header.writeUInt32LE(offset, 42);
    locals.push(local, name, localExtra, compressed); central.push(header, name, centralExtra); offset += local.length + name.length + localExtra.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
function synthetic(version = "v0.0.16") {
  const pin = { ...TUNNEL_RELEASES.x64!, release: version, archive: `tunnel-client-${version}-windows-amd64.zip` }, names = tunnelReleaseFiles(pin), files = new Map<string, Buffer>();
  for (const name of names.slice(0, -1)) files.set(name, name.endsWith(".exe") ? Buffer.concat([Buffer.from("MZ"), Buffer.alloc(62)]) : Buffer.from(`synthetic ${name}`));
  const sbom = Buffer.from(JSON.stringify({ spdxVersion: "SPDX-2.3", name: "tunnel-client", files: [...files].map(([name, bytes]) => ({ fileName: `./${name}`, checksums: [{ algorithm: "SHA256", checksumValue: tunnelDigest(bytes) }] })) }));
  files.set(names[6]!, sbom); const entries = [...files].map(([name, data]) => ({ name, data })), bytes = zip(entries);
  const release: TunnelRelease = { ...pin, bytes: bytes.length, sha256: tunnelDigest(bytes), sbomSha256: tunnelDigest(sbom) };
  return { files, bytes, release, entries };
}
void test("legacy pinned installation is verified and adopted read-only without key entry, download, or owned-root writes", async t => {
  const legacy = workspace(t), owned = join(legacy, "..", "ai-tools"), fixture = synthetic();
  const original = new TunnelToolInstaller(legacy, { platform: "win32", release: fixture.release, download: async () => fixture.bytes });
  original.setEnabled(true); await original.install(() => true, signal());
  const receipt = readFileSync(join(legacy, "current.json")), executable = original.verifiedExecutablePath();
  let downloads = 0;
  const adopter = new AdoptingTunnelToolInstaller(owned, legacy, { platform: "win32", release: fixture.release, download: async () => { downloads++; throw new Error("must remain offline"); } });
  assert.equal(adopter.status().phase, "installed"); assert.equal(adopter.status().enabled, false);
  assert.equal(adopter.verifiedExecutablePath(), executable); assert.equal(existsSync(owned), false);
  adopter.setEnabled(true); await adopter.install(() => true, signal());
  assert.equal(downloads, 0); assert.deepEqual(readFileSync(join(legacy, "current.json")), receipt); assert.equal(existsSync(owned), false);
  await assert.rejects(adopter.rollback(() => true, signal()), /read-only/);
  writeFileSync(join(legacy, "install.lock"), "synthetic recovery marker"); assert.throws(() => adopter.verifiedExecutablePath());
  assert.equal(readFileSync(join(legacy, "install.lock"), "utf8"), "synthetic recovery marker");
});
void test("legacy corruption cannot fall back or replace its files; explicit new installs belong to AI DM", async t => {
  const legacy = workspace(t), owned = join(legacy, "..", "ai-tools"), fixture = synthetic();
  const original = new TunnelToolInstaller(legacy, { platform: "win32", release: fixture.release, download: async () => fixture.bytes });
  original.setEnabled(true); await original.install(() => true, signal());
  const receipt = readFileSync(join(legacy, "current.json")), executable = original.verifiedExecutablePath();
  writeFileSync(executable, "synthetic corruption");
  const adopter = new AdoptingTunnelToolInstaller(owned, legacy, { platform: "win32", release: fixture.release }); adopter.setEnabled(true);
  assert.equal(adopter.status().phase, "error"); assert.throws(() => adopter.verifiedExecutablePath());
  await assert.rejects(adopter.install(() => true, signal())); assert.deepEqual(readFileSync(join(legacy, "current.json")), receipt); assert.equal(existsSync(owned), false);
  const fresh = new AdoptingTunnelToolInstaller(owned, join(legacy, "..", "absent-legacy"), { platform: "win32", release: fixture.release, download: async () => fixture.bytes });
  fresh.setEnabled(true); await fresh.install(() => true, signal()); assert.ok(fresh.verifiedExecutablePath().startsWith(owned));
  assert.deepEqual(readFileSync(join(legacy, "current.json")), receipt);
  assert.throws(() => new AdoptingTunnelToolInstaller(owned, owned));
});
void test("adoption refuses owned reparse roots, partial staging, unknown files and either recovery lock without cleanup", async t => {
  const legacy = workspace(t), owned = join(legacy, "..", "ai-tools"), fixture = synthetic();
  const original = new TunnelToolInstaller(legacy, { platform: "win32", release: fixture.release, download: async () => fixture.bytes });
  original.setEnabled(true); await original.install(() => true, signal());
  const adopter = () => new AdoptingTunnelToolInstaller(owned, legacy, { platform: "win32", release: fixture.release });
  mkdirSync(owned);
  assert.equal(adopter().status().phase, "installed");
  for (const name of ["install.lock", "foreign.txt", "staging-interrupted"]) {
    const marker = join(owned, name); if (name.startsWith("staging")) mkdirSync(marker); else writeFileSync(marker, "synthetic preserved state");
    const current = adopter(); current.setEnabled(true); assert.equal(current.status().phase, "error"); assert.throws(() => current.verifiedExecutablePath());
    await assert.rejects(current.install(() => true, signal())); assert.equal(existsSync(marker), true);
    if (name.startsWith("staging")) rmdirSync(marker); else rmSync(marker);
  }
  rmdirSync(owned); const target = join(legacy, "..", "real-ai-tools"); mkdirSync(target);
  symlinkSync(target, owned, process.platform === "win32" ? "junction" : "dir");
  assert.equal(adopter().status().phase, "error"); assert.throws(() => adopter().verifiedExecutablePath()); assert.equal(readdirSync(target).length, 0);
  unlinkSync(owned); writeFileSync(join(legacy, "install.lock"), "synthetic legacy lock");
  assert.equal(adopter().status().phase, "error"); assert.throws(() => adopter().verifiedExecutablePath());
  assert.equal(readFileSync(join(legacy, "install.lock"), "utf8"), "synthetic legacy lock");
});
void test("display pin hint is bounded and metadata invalidated; every activation still freshly hashes the complete bundle once", async t => {
  const root = workspace(t), fixture = synthetic(); let now = 1000;
  const samples: { component: string; elapsedMs: number; bytes: number }[] = [];
  const installer = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release, reviewedReleases: [fixture.release], now: () => now, verificationTiming: sample => samples.push(sample), download: async () => fixture.bytes });
  installer.setEnabled(true); await installer.install(() => true, signal()); samples.length = 0;
  assert.equal(installer.displayStatus().phase, "installed"); assert.equal(samples.length, 1);
  installer.displayStatus(); installer.displayExecutablePath(); assert.equal(samples.length, 1);
  installer.verifiedExecutablePath(); installer.verifiedExecutablePath(); assert.equal(samples.length, 3);
  assert.ok(samples.every(sample => sample.component === "pin_hash" && sample.bytes > 0 && sample.elapsedMs >= 0));
  now += 2000; installer.displayStatus(); assert.equal(samples.length, 4);
  const path = installer.verifiedExecutablePath(); writeFileSync(path, "synthetic corrupt executable");
  assert.equal(installer.displayStatus().phase, "error"); assert.throws(() => installer.verifiedExecutablePath());
  t.diagnostic(JSON.stringify({ component: "synthetic_complete_bundle", verificationPasses: samples.length, totalBytes: samples.reduce((sum, sample) => sum + sample.bytes, 0), elapsedMs: samples.reduce((sum, sample) => sum + sample.elapsedMs, 0) }));
});
function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "foundry-tunnel-synthetic-"));
  t.after(() => { const checked = resolve(root); if (!checked.startsWith(`${resolve(tmpdir())}\\foundry-tunnel-synthetic-`) && !checked.startsWith(`${resolve(tmpdir())}/foundry-tunnel-synthetic-`)) throw new Error("Unsafe synthetic cleanup"); rmSync(checked, { recursive: true, force: true }); }); return join(root, "app-tools");
}
const signal = () => new AbortController().signal;
void test("pinned downloader lookup supports Node's single and automatic all-address callback shapes", () => {
  const address = { address: "8.8.8.8", family: 4 }, lookup = pinnedTunnelLookup(address);
  lookup("synthetic.invalid", { all: true }, (error, result) => { assert.equal(error, null); assert.deepEqual(result, [address]); });
  lookup("synthetic.invalid", { all: false }, (error, result, family) => { assert.equal(error, null); assert.equal(result, address.address); assert.equal(family, 4); });
});

void test("pins official release URLs and rejects arbitrary URLs or redirect hosts", () => {
  for (const release of Object.values(TUNNEL_RELEASES)) { const initial = tunnelReleaseUrl(release); assert.equal(allowedTunnelDownloadUrl(initial, initial, false).hostname, "github.com"); }
  const initial = tunnelReleaseUrl(TUNNEL_RELEASES.x64!);
  assert.equal(allowedTunnelDownloadUrl("https://release-assets.githubusercontent.com/asset?signed=transient", initial, true).hostname, "release-assets.githubusercontent.com");
  for (const value of ["http://github.com/release", "https://127.0.0.1/", "https://github.com.evil.example/", "https://evil.example/", "https://user:secret@release-assets.githubusercontent.com/asset", "https://release-assets.githubusercontent.com:444/asset", "https://github.com/openai/tunnel-client/releases/download/v0.0.17/file.zip"]) assert.throws(() => allowedTunnelDownloadUrl(value, initial, true));
  assert.throws(() => allowedTunnelDownloadUrl("https://evil.example/file.zip", "https://evil.example/file.zip", false));
});
void test("ZIP verifies complete bundle and rejects corruption, unsafe members, duplicates, links and bombs", () => {
  const fixture = synthetic(); assert.deepEqual([...unpackTunnelRelease(fixture.bytes, fixture.release).keys()], tunnelReleaseFiles(fixture.release));
  const badDigest = Buffer.from(fixture.bytes); badDigest[0] = 0; assert.throws(() => unpackTunnelRelease(badDigest, fixture.release), /checksum mismatch/);
  for (const change of [{ name: "../tunnel-client.exe" }, { name: "C:\\tool.exe" }, { name: "folder/tool.exe" }, { name: "LICENSE" }, { attributes: (0o120777 << 16) >>> 0 }, { flags: 1 }, { declaredSize: 97 * 1024 * 1024 }, { declaredSize: 1 }]) {
    const entries = fixture.entries.map((entry, index) => index === 0 ? { ...entry, ...change } : entry), bytes = zip(entries);
    assert.throws(() => unpackTunnelRelease(bytes, { ...fixture.release, bytes: bytes.length, sha256: tunnelDigest(bytes) }), /verification/);
  }
  assert.throws(() => unpackTunnelRelease(fixture.bytes, { ...fixture.release, sbomSha256: "0".repeat(64) }), /verification/);
});
void test("official ZIP compression-level flags and extra metadata remain compatible without allowing encryption or reserved flags", () => {
  const fixture = synthetic();
  for (const flags of [2, 4, 6]) {
    const bytes = zip(fixture.entries.map(entry => ({ ...entry, flags, localExtra: Buffer.alloc(28), centralExtra: Buffer.alloc(24) })));
    assert.deepEqual([...unpackTunnelRelease(bytes, { ...fixture.release, bytes: bytes.length, sha256: tunnelDigest(bytes) }).keys()], tunnelReleaseFiles(fixture.release));
  }
  for (const flags of [1, 0x10, 0x20, 0x40, 0x2000]) {
    const bytes = zip(fixture.entries.map(entry => ({ ...entry, flags })));
    assert.throws(() => unpackTunnelRelease(bytes, { ...fixture.release, bytes: bytes.length, sha256: tunnelDigest(bytes) }), /verification/);
  }
  const stored = zip(fixture.entries.map(entry => ({ ...entry, flags: 2, method: 0 })));
  assert.throws(() => unpackTunnelRelease(stored, { ...fixture.release, bytes: stored.length, sha256: tunnelDigest(stored) }), /verification/);
});
void test("offline official Windows ZIP fixture passes complete pinned archive and SPDX verification", { skip: !process.env["FOUNDRY_TUNNEL_ARCHIVE_FIXTURE"] }, () => {
  const pin = TUNNEL_RELEASES.x64!, bytes = readFileSync(process.env["FOUNDRY_TUNNEL_ARCHIVE_FIXTURE"]!);
  assert.equal(bytes.length, pin.bytes); assert.equal(tunnelDigest(bytes), pin.sha256);
  assert.deepEqual([...unpackTunnelRelease(bytes, pin).keys()], tunnelReleaseFiles(pin));
});
void test("constructor/status are offline; disabled and unsupported install never creates files", async t => {
  const root = workspace(t), fixture = synthetic(); let downloads = 0;
  const installer = new TunnelToolInstaller(root, { platform: "win32", arch: "x64", release: fixture.release, download: async () => { downloads++; return fixture.bytes; } });
  assert.equal(installer.status().enabled, false); assert.equal(installer.status().phase, "not_installed");
  await assert.rejects(installer.install(() => true, signal()), /disabled/); assert.equal(downloads, 0); assert.equal(existsSync(root), false);
  const unsupported = new TunnelToolInstaller(root, { platform: "linux" }); unsupported.setEnabled(true); assert.equal(unsupported.status().phase, "unsupported"); await assert.rejects(unsupported.install(() => true, signal())); assert.equal(existsSync(root), false);
});
void test("verified atomic installation retains notices and is idempotent without executing binaries", async t => {
  const root = workspace(t), fixture = synthetic(); let downloads = 0;
  const installer = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release, download: async () => { downloads++; return fixture.bytes; } }); installer.setEnabled(true);
  assert.equal((await installer.install(() => true, signal())).phase, "installed"); assert.equal(downloads, 1);
  const directory = readdirSync(root).find(name => name.startsWith("v0.0.16-"))!; assert.deepEqual(readdirSync(join(root, directory)).sort(), tunnelReleaseFiles(fixture.release).sort());
  await installer.install(() => true, signal()); assert.equal(downloads, 1); assert.equal(existsSync(join(root, "install.lock")), false);
  const restarted = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release, download: async () => { throw new Error("must remain offline"); } }); assert.equal(restarted.status().phase, "installed"); assert.equal(restarted.status().enabled, false);
  assert.equal(restarted.verifiedExecutablePath(), join(root, directory, "tunnel-client.exe"));
  writeFileSync(join(root, "install.lock"), "synthetic interrupted installer");
  assert.throws(() => restarted.verifiedExecutablePath()); rmSync(join(root, "install.lock"));
  writeFileSync(join(root, directory, "cloudflared.exe"), "tampered"); assert.equal(restarted.status().phase, "error"); assert.ok(existsSync(join(root, "current.json")));
  assert.throws(() => restarted.verifiedExecutablePath());
});
void test("failed download, integrity or revocation retains the previous version and pointer", async t => {
  const root = workspace(t), fixture = synthetic(); mkdirSync(root);
  const previous = JSON.stringify({ version: 1, release: "v0.0.15", platform: "windows-amd64", sha256: "1".repeat(64) }); writeFileSync(join(root, "current.json"), previous);
  for (const failure of ["offline", "integrity", "revoked"]) {
    let authorized = true;
    const installer = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release, download: async () => { if (failure === "offline") throw new Error("untrusted sensitive network details"); if (failure === "revoked") authorized = false; return failure === "integrity" ? Buffer.alloc(fixture.bytes.length) : fixture.bytes; } }); installer.setEnabled(true);
    await assert.rejects(installer.install(() => authorized, signal())); assert.equal(readFileSync(join(root, "current.json"), "utf8"), previous); assert.equal(existsSync(join(root, "install.lock")), false); assert.ok(!installer.status().message.includes("sensitive"));
  }
});
void test("explicit update retains verified previous bundle, supports offline rollback and marks tunnel restart", async t => {
  const root = workspace(t), previous = synthetic("v0.0.15"), required = synthetic();
  const old = new TunnelToolInstaller(root, { platform: "win32", release: previous.release, download: async () => previous.bytes }); old.setEnabled(true); await old.install(() => true, signal());
  const priorPointer = readFileSync(join(root, "current.json"), "utf8");
  let downloads = 0;
  const update = new TunnelToolInstaller(root, { platform: "win32", release: required.release, reviewedReleases: [previous.release, required.release], download: async () => { downloads++; return required.bytes; } }); update.setEnabled(true);
  assert.equal(update.status().phase, "different_version");
  await update.install(() => true, signal()); assert.equal(downloads, 1);
  assert.equal(update.status().installedVersion, "v0.0.16"); assert.equal(update.status().retainedVersion, "v0.0.15"); assert.equal(update.status().rollbackAvailable, true); assert.equal(update.status().restartNeeded, true);
  await assert.rejects(update.rollback(() => false, signal())); assert.equal(update.status().installedVersion, "v0.0.16");
  await update.rollback(() => true, signal()); assert.equal(update.status().installedVersion, "v0.0.15"); assert.equal(update.status().phase, "different_version"); assert.equal(update.status().retainedVersion, "v0.0.16"); assert.equal(downloads, 1);
  assert.notEqual(readFileSync(join(root, "current.json"), "utf8"), priorPointer);
  await update.install(() => true, signal()); assert.equal(downloads, 1); assert.equal(update.status().installedVersion, "v0.0.16");
  const retainedDirectory = readdirSync(root).find(name => name.startsWith("v0.0.15-"))!; writeFileSync(join(root, retainedDirectory, "cloudflared.exe"), "corrupt");
  const current = readFileSync(join(root, "current.json"), "utf8"); assert.equal(update.status().rollbackAvailable, false); await assert.rejects(update.rollback(() => true, signal()), /unavailable/); assert.equal(readFileSync(join(root, "current.json"), "utf8"), current);
});
void test("unknown previous pin is retained but never offered as verified rollback", async t => {
  const root = workspace(t), fixture = synthetic(); mkdirSync(root);
  writeFileSync(join(root, "current.json"), JSON.stringify({ version: 1, release: "v0.0.15", platform: "windows-amd64", sha256: "1".repeat(64) }));
  const installer = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release, download: async () => fixture.bytes }); installer.setEnabled(true); await installer.install(() => true, signal());
  assert.equal(installer.status().retainedVersion, "v0.0.15"); assert.equal(installer.status().rollbackAvailable, false); await assert.rejects(installer.rollback(() => true, signal()), /unavailable/);
});
void test("one process or competing process cannot race an installation or reclaim its lock", async t => {
  const root = workspace(t), fixture = synthetic(); let release: (() => void) | undefined, entered: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const installer = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release, download: async () => { entered!(); await gate; return fixture.bytes; } }); installer.setEnabled(true);
  const work = installer.install(() => true, signal()); await started; assert.equal(installer.status().phase, "installing");
  await assert.rejects(installer.install(() => true, signal()), /progress/);
  const other = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release }); other.setEnabled(true); await assert.rejects(other.install(() => true, signal()), /locked/); assert.ok(existsSync(join(root, "install.lock")));
  release!(); await work; assert.equal(installer.status().phase, "installed");
});
void test("foreign stale locks and reparse roots are refused without cleanup of foreign files", async t => {
  const root = workspace(t), fixture = synthetic(); mkdirSync(root); writeFileSync(join(root, "install.lock"), "foreign");
  const installer = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release }); installer.setEnabled(true); await assert.rejects(installer.install(() => true, signal()), /locked/); assert.equal(readFileSync(join(root, "install.lock"), "utf8"), "foreign");
  const target = join(root, "real"), link = join(root, "linked"); mkdirSync(target); symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  const unsafe = new TunnelToolInstaller(join(link, "tools"), { platform: "win32", release: fixture.release }); unsafe.setEnabled(true); await assert.rejects(unsafe.install(() => true, signal())); assert.equal(existsSync(join(target, "tools")), false);
});
void test("verified GM setup binds one session owner and rejects broad input, wrong world and non-GM", async t => {
  const root = workspace(t), fixture = synthetic(); let downloads = 0, live = true;
  const replies: { status: { phase: string; enabled: boolean; errorCode?: string } }[] = [];
  const installer = new TunnelToolInstaller(root, { platform: "win32", release: fixture.release, download: async () => { downloads++; return fixture.bytes; } });
  const service = new TunnelSetupService(installer, { getVerifiedFoundryIdentity: selector => live && selector.userId === "gm" ? { worldId: "world", userId: "gm", userName: "GM", role: 4, isGM: true } : null, send: raw => { replies.push(JSON.parse(raw) as typeof replies[number]); return true; } });
  const sender = { clientId: "client", userId: "gm", lane: "gm" }, input = (action: string) => ({ requestId: randomUUID(), worldId: "world", action });
  await service.handle({ ...input("install"), confirmed: true }, sender); assert.equal(replies.at(-1)!.status.errorCode, "disabled");
  const before = replies.length; await service.handle(input("enable"), { ...sender, lane: "player" }); await service.handle({ ...input("enable"), worldId: "other" }, sender); await service.handle({ ...input("enable"), url: "https://evil.example/" }, sender); await service.handle({ ...input("enable"), version: "v99" }, sender); await service.handle({ ...input("enable"), path: "C:\\other" }, sender); assert.equal(replies.length, before); assert.equal(downloads, 0);
  await service.handle(input("enable"), sender); assert.equal(replies.at(-1)!.status.enabled, true);
  await service.handle(input("enable"), { ...sender, clientId: "other-client" }); assert.equal(replies.at(-1)!.status.errorCode, "busy");
  await service.handle({ ...input("install"), confirmed: true }, sender); assert.equal(downloads, 1); assert.equal(replies.at(-1)!.status.phase, "installed");
  service.disconnected(sender.clientId); assert.equal(installer.status().enabled, false); live = false; await service.handle(input("enable"), sender); assert.equal(installer.status().enabled, false);
});
