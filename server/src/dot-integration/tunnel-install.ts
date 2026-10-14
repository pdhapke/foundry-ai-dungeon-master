import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { downloadTunnelRelease } from "./tunnel-download.js";
import { unpackTunnelRelease, verifyTunnelFiles } from "./tunnel-archive.js";
import { REVIEWED_TUNNEL_RELEASES, TUNNEL_RELEASE, TUNNEL_RELEASES, TunnelInstallError, tunnelReleaseFiles, type TunnelRelease } from "./tunnel-release.js";

export interface TunnelToolStatus { enabled: boolean; phase: "unsupported" | "not_installed" | "installed" | "different_version" | "installing" | "error"; requiredVersion: string; platform: string; installedVersion?: string; retainedVersion?: string; rollbackAvailable?: boolean; restartNeeded?: boolean; message: string; errorCode?: string }
const descriptorSchema = z.object({ release: z.string().regex(/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/), platform: z.enum(["windows-amd64", "windows-arm64"]), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const currentSchema = descriptorSchema.extend({ version: z.literal(1), previous: descriptorSchema.optional(), restartNeeded: z.boolean().optional() }).strict();
type Descriptor = z.infer<typeof descriptorSchema>;
const unsafe = () => new TunnelInstallError("storage", "App tools storage is unsafe or not writable. Ask the local operator to inspect it; no permissions were changed.");
const installationDirectory = (value: { release: string; platform: string; sha256: string }): string => `${value.release}-${value.platform}-${value.sha256.slice(0, 12)}`;
/** Tests may replace the release/downloader with synthetic bytes. Production
 * construction supplies only a fixed application-owned root, never tool args.
 */
export interface TunnelInstallerDependencies { platform?: string; arch?: string; release?: TunnelRelease; reviewedReleases?: readonly TunnelRelease[]; download?: (release: TunnelRelease, signal: AbortSignal) => Promise<Buffer>; now?: () => number; verificationTiming?: (sample: { component: "pin_hash"; elapsedMs: number; bytes: number }) => void }

export class TunnelToolInstaller {
  private enabled = false;
  private installing: AbortController | undefined;
  private readonly release: TunnelRelease | undefined;
  private readonly root: string;
  private lastError: TunnelInstallError | undefined;
  private display: { fingerprint: string; expires: number; status: TunnelToolStatus } | undefined;
  constructor(root: string, private readonly dependencies: TunnelInstallerDependencies = {}) {
    this.root = resolve(root);
    this.release = (dependencies.platform ?? process.platform) === "win32" ? dependencies.release ?? TUNNEL_RELEASES[dependencies.arch ?? process.arch] : undefined;
  }
  setEnabled(enabled: boolean): void { this.enabled = enabled; this.display = undefined; if (!enabled) this.installing?.abort(); }
  /** Read-only display hint, never authority for activation or installation.
   * One entry, two-second bound, invalidated by receipts, locks and file identity
   * metadata. Every mutation/activation still hashes the complete bundle freshly. */
  displayStatus(): TunnelToolStatus {
    const now = (this.dependencies.now ?? Date.now)();
    try {
      const current = this.readCurrent();
      const names = ["current.json", "install.lock"];
      for (const descriptor of [current, current?.previous]) {
        if (!descriptor) continue;
        const directory = installationDirectory(descriptor);
        names.push(directory);
        if (existsSync(this.path(directory))) names.push(...readdirSync(this.path(directory)).sort().map(name => join(directory, name)));
      }
      const fingerprint = JSON.stringify(names.map(name => {
        const path = this.path(name);
        if (!existsSync(path)) return [name, null];
        const stat = lstatSync(path);
        return [name, stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs];
      }));
      if (this.display && now >= this.display.expires - 2000 && now < this.display.expires && this.display.fingerprint === fingerprint) return { ...this.display.status, enabled: this.enabled };
      const status = this.status(); this.display = { fingerprint, expires: now + 2000, status }; return { ...status };
    } catch { this.display = undefined; return this.status(); }
  }
  /** This path is only a display prerequisite. Never pass it to a process launch. */
  displayExecutablePath(): string {
    if (this.displayStatus().phase !== "installed" || existsSync(this.path("install.lock"))) throw unsafe();
    const current = this.readCurrent();
    if (!this.release || !current || current.release !== this.release.release || current.platform !== this.release.platform || current.sha256 !== this.release.sha256) throw unsafe();
    return this.path(join(installationDirectory(current), "tunnel-client.exe"));
  }
  /** Activation never accepts a browser path/version or downloads anything. */
  verifiedExecutablePath(): string {
    const current = this.readCurrent();
    if (this.installing || existsSync(this.path("install.lock")) || !this.release || !current || current.release !== this.release.release || current.platform !== this.release.platform || current.sha256 !== this.release.sha256) throw unsafe();
    this.files(installationDirectory(current));
    return this.path(join(installationDirectory(current), "tunnel-client.exe"));
  }
  private path(relative = ""): string {
    const target = resolve(this.root, relative);
    if (target !== this.root && !target.startsWith(`${this.root}\\`) && !target.startsWith(`${this.root}/`)) throw unsafe();
    for (let cursor = target; ; cursor = dirname(cursor)) {
      if (existsSync(cursor)) { const info = lstatSync(cursor); if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1) || realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()) throw unsafe(); }
      if (dirname(cursor) === cursor) break;
    }
    return target;
  }
  private files(directory: string, release = this.release!): Map<string, Buffer> {
    const started = performance.now();
    const files = new Map<string, Buffer>();
    const expected = tunnelReleaseFiles(release), actual = readdirSync(this.path(directory));
    if (actual.length !== expected.length || actual.some(name => !expected.includes(name))) throw unsafe();
    let total = 0;
    for (const name of expected) {
      const path = this.path(join(directory, name)), info = lstatSync(path);
      total += info.size;
      if (!info.isFile() || info.size > (name.endsWith(".spdx.json") ? 1024 * 1024 : 96 * 1024 * 1024) || total > 192 * 1024 * 1024) throw unsafe(); files.set(name, readFileSync(path));
    }
    verifyTunnelFiles(files, release);
    try { this.dependencies.verificationTiming?.({ component: "pin_hash", elapsedMs: Math.max(0, performance.now() - started), bytes: total }); } catch { /* Diagnostics never affect verification. */ }
    return files;
  }
  private readCurrent(): z.infer<typeof currentSchema> | undefined {
    const path = this.path("current.json"); if (!existsSync(path)) return undefined;
    if (!lstatSync(path).isFile() || lstatSync(path).size > 2048) throw unsafe();
    return currentSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }
  private reviewed(value: Descriptor): TunnelRelease | undefined { return (this.dependencies.reviewedReleases ?? REVIEWED_TUNNEL_RELEASES).find(pin => pin.release === value.release && pin.platform === value.platform && pin.sha256 === value.sha256); }
  private canRollback(previous: Descriptor | undefined): boolean {
    if (!previous || previous.platform !== this.release?.platform) return false;
    const pin = this.reviewed(previous); if (!pin) return false;
    try { this.files(installationDirectory(previous), pin); return true; } catch { return false; }
  }
  status(): TunnelToolStatus {
    const base = { enabled: this.enabled, requiredVersion: TUNNEL_RELEASE, platform: this.release?.platform ?? `${this.dependencies.platform ?? process.platform}-${this.dependencies.arch ?? process.arch}` };
    if (!this.release) return { ...base, phase: "unsupported", message: "App-managed tunnel setup supports Windows x64 and arm64. Ask the maintainer for a reviewed platform release." };
    if (this.installing) return { ...base, phase: "installing", message: "Downloading and verifying the required official tunnel tool." };
    try {
      const current = this.readCurrent();
      if (!current) return { ...base, ...(this.lastError ? { phase: "error" as const, errorCode: this.lastError.code, message: this.lastError.message } : { phase: "not_installed" as const, message: "Required tunnel tool is not installed. Enable downloads for this session, then choose Install." }) };
      const update = { ...(current.previous ? { retainedVersion: current.previous.release } : {}), rollbackAvailable: this.canRollback(current.previous), restartNeeded: current.restartNeeded === true };
      const selectedPin = this.reviewed(current); if (selectedPin) this.files(installationDirectory(current), selectedPin);
      if (current.release !== this.release.release || current.platform !== this.release.platform || current.sha256 !== this.release.sha256) return { ...base, ...update, phase: "different_version", installedVersion: current.release, message: this.lastError?.message ?? "An existing version is retained. Install the version required by this Foundry integration.", ...(this.lastError ? { errorCode: this.lastError.code } : {}) };
      if (!selectedPin) this.files(installationDirectory(current));
      return { ...base, ...update, phase: "installed", installedVersion: current.release, message: this.lastError?.message ?? (current.restartNeeded ? "Updated tool verified. Restart an existing tunnel through the operator's supported launcher to use it; no running process was changed." : "Required tunnel tool is verified and installed. Tunnel credentials and activation are separate setup steps."), ...(this.lastError ? { errorCode: this.lastError.code } : {}) };
    } catch { return { ...base, phase: "error", errorCode: "storage", message: "Installed tool verification failed. Ask the local operator to inspect app tools storage; existing files were retained." }; }
  }
  async install(authorized: () => boolean, external: AbortSignal): Promise<TunnelToolStatus> {
    this.display = undefined;
    if (!this.enabled) throw new TunnelInstallError("disabled", "Downloads are disabled. Enable them explicitly in Foundry setup for this session.");
    if (!this.release) throw new TunnelInstallError("unsupported", "No reviewed release exists for this platform.");
    if (this.installing) throw new TunnelInstallError("busy", "Another installation is in progress. Check status before retrying.");
    if (!authorized()) throw new TunnelInstallError("unauthorized", "The verified GM setup connection is no longer active.");
    this.lastError = undefined;
    if (this.status().phase === "installed") return this.status();
    const cancellation = new AbortController(); this.installing = cancellation;
    const signal = AbortSignal.any([external, cancellation.signal, AbortSignal.timeout(150000)]);
    let lock: number | undefined, stage: string | undefined, receipt: string | undefined;
    try {
      signal.throwIfAborted(); this.path(); mkdirSync(this.root, { recursive: true }); this.path();
      const lockPath = this.path("install.lock");
      try { lock = openSync(lockPath, "wx", 0o600); } catch { throw new TunnelInstallError("busy", "App tool installation is locked. Check the other installer; ask the operator to inspect a stale lock rather than deleting it automatically."); }
      const target = installationDirectory(this.release);
      const prior = this.readCurrent();
      if (!existsSync(this.path(target))) {
        const archive = await (this.dependencies.download ?? downloadTunnelRelease)(this.release, signal);
        signal.throwIfAborted(); const files = unpackTunnelRelease(archive, this.release);
        if (!authorized() || !this.enabled) throw new TunnelInstallError("unauthorized", "The verified GM setup connection is no longer active.");
        this.path(); stage = mkdtempSync(join(this.root, ".stage-")); this.path(stage);
        for (const [name, bytes] of files) { signal.throwIfAborted(); this.writeExclusive(join(stage, name), bytes); }
        this.files(stage); signal.throwIfAborted(); if (!authorized() || !this.enabled) throw new TunnelInstallError("unauthorized", "The verified GM setup connection is no longer active.");
        this.path(target); renameSync(stage, this.path(target)); stage = undefined;
      } else this.files(target);
      signal.throwIfAborted(); if (!authorized() || !this.enabled) throw new TunnelInstallError("unauthorized", "The verified GM setup connection is no longer active.");
      receipt = this.path(`.current-${randomUUID()}.json`);
      this.writeExclusive(receipt, Buffer.from(JSON.stringify({ version: 1, release: this.release.release, platform: this.release.platform, sha256: this.release.sha256, ...(prior ? { previous: { release: prior.release, platform: prior.platform, sha256: prior.sha256 }, restartNeeded: true } : {}) })));
      this.path("current.json"); renameSync(receipt, this.path("current.json")); receipt = undefined;
    } catch (error) {
      this.lastError = error instanceof TunnelInstallError ? error : new TunnelInstallError(signal.aborted ? "cancelled" : "storage", signal.aborted ? "Installation canceled; existing version retained. Retry from Foundry setup." : "App tools installation failed. Check free space and folder permissions; existing version retained.");
      throw this.lastError;
    } finally {
      // Only paths exclusively created by this attempt may be removed. Resolved
      // absolute containment and reparse checks precede recursive stage cleanup.
      if (stage) { try { const checked = this.path(stage); if (dirname(checked) === this.root && checked.startsWith(join(this.root, ".stage-")) && readdirSync(checked).every(name => lstatSync(this.path(join(checked, name))).isFile())) rmSync(checked, { recursive: true }); } catch { /* Preserve unsafe/unresolved artifacts for operator review. */ } }
      if (receipt) { try { unlinkSync(this.path(receipt)); } catch { /* Preserve unresolved write. */ } }
      if (lock !== undefined) { closeSync(lock); try { unlinkSync(this.path("install.lock")); } catch { /* Never reclaim a foreign lock. */ } }
      this.installing = undefined;
    }
    return this.status();
  }
  // Keep the guarded pointer swap synchronous while preserving the async adapter contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  async rollback(authorized: () => boolean, signal: AbortSignal): Promise<TunnelToolStatus> {
    this.display = undefined;
    if (!this.enabled || !authorized()) throw new TunnelInstallError("disabled", "Enable session setup and confirm rollback from the connected verified GM.");
    if (this.installing) throw new TunnelInstallError("busy", "Another installation is in progress.");
    let lock: number | undefined, receipt: string | undefined;
    try {
      signal.throwIfAborted(); this.path();
      try { lock = openSync(this.path("install.lock"), "wx", 0o600); } catch { throw new TunnelInstallError("busy", "App tool installation is locked. Ask the operator to inspect it."); }
      const current = this.readCurrent(), previous = current?.previous;
      if (!current || !previous || !this.canRollback(previous)) throw new TunnelInstallError("rollback", "The retained version has no reviewed manifest or failed verification. Rollback is unavailable; existing versions were retained.");
      this.files(installationDirectory(previous), this.reviewed(previous));
      signal.throwIfAborted(); if (!this.enabled || !authorized()) throw new TunnelInstallError("unauthorized", "The verified GM setup connection is no longer active.");
      receipt = this.path(`.current-${randomUUID()}.json`);
      this.writeExclusive(receipt, Buffer.from(JSON.stringify({ version: 1, ...previous, previous: { release: current.release, platform: current.platform, sha256: current.sha256 }, restartNeeded: true })));
      this.path("current.json"); renameSync(receipt, this.path("current.json")); receipt = undefined; this.lastError = undefined;
    } catch (error) { throw error instanceof TunnelInstallError ? error : new TunnelInstallError("storage", "Rollback failed; existing version selection was retained. Ask the operator to inspect app tools storage."); }
    finally { if (receipt) { try { unlinkSync(this.path(receipt)); } catch { /* Preserve unresolved write. */ } } if (lock !== undefined) { closeSync(lock); try { unlinkSync(this.path("install.lock")); } catch { /* Preserve unresolved lock. */ } } }
    return this.status();
  }
  private writeExclusive(path: string, bytes: Buffer): void {
    const checked = this.path(path), fd = openSync(checked, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
}
