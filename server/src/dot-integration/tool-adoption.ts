import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { resolve, join, isAbsolute, dirname } from "node:path";
import { TunnelToolInstaller, type TunnelInstallerDependencies, type TunnelToolStatus } from "./tunnel-install.js";
import { TunnelInstallError } from "./tunnel-release.js";

/** The legacy root is never written or repaired. New installations belong to AI DM. */
export class AdoptingTunnelToolInstaller extends TunnelToolInstaller {
  private readonly legacy: TunnelToolInstaller;
  constructor(readonly ownedRoot: string, readonly legacyRoot: string, dependencies: TunnelInstallerDependencies = {}) {
    const owned = resolve(ownedRoot).toLowerCase(), legacy = resolve(legacyRoot).toLowerCase();
    if (!isAbsolute(ownedRoot) || !isAbsolute(legacyRoot) || owned === legacy || owned.startsWith(`${legacy}/`) || owned.startsWith(`${legacy}\\`) || legacy.startsWith(`${owned}/`) || legacy.startsWith(`${owned}\\`)) throw new TunnelInstallError("storage", "Tunnel tool ownership roots must be absolute, distinct and non-overlapping.");
    super(ownedRoot, dependencies); this.legacy = new TunnelToolInstaller(legacyRoot, dependencies);
  }
  private useLegacy(): boolean {
    // Explicit owned receipts take precedence, but never fall back from unsafe
    // owned storage, interrupted staging, unknown files or a recovery marker.
    if (existsSync(join(this.ownedRoot, "current.json"))) return false;
    const owned = super.status();
    if (owned.phase === "installing") return false;
    if (owned.phase === "error") throw this.unsafeAdoption();
    // lstat also detects dangling links that existsSync deliberately hides.
    for (let cursor = resolve(this.ownedRoot); ; cursor = dirname(cursor)) {
      let metadata;
      try { metadata = lstatSync(cursor); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw this.unsafeAdoption(); }
      if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(cursor).toLowerCase() !== cursor.toLowerCase() || (cursor === resolve(this.ownedRoot) && readdirSync(cursor).length !== 0))) throw this.unsafeAdoption();
      if (dirname(cursor) === cursor) break;
    }
    if (existsSync(join(this.legacyRoot, "install.lock"))) throw this.unsafeAdoption();
    return existsSync(join(this.legacyRoot, "current.json"));
  }
  private unsafeAdoption(): TunnelInstallError { return new TunnelInstallError("storage", "Tool adoption is blocked by unsafe or interrupted storage. Existing files were preserved for local review."); }
  override verifiedExecutablePath(): string {
    return this.useLegacy() ? this.legacy.verifiedExecutablePath() : super.verifiedExecutablePath();
  }
  override displayExecutablePath(): string { return this.useLegacy() ? this.legacy.displayExecutablePath() : super.displayExecutablePath(); }
  override displayStatus(): TunnelToolStatus {
    try {
      if (!this.useLegacy()) return super.displayStatus();
      const status = this.legacy.displayStatus();
      return { ...status, enabled: super.status().enabled, rollbackAvailable: false,
        ...(status.phase === "installed" ? { message: "Existing pinned tunnel tool verified and adopted in place. Activation re-verifies all pinned files." } : {}) };
    } catch { return this.status(); }
  }
  override status(): TunnelToolStatus {
    try {
      if (!this.useLegacy()) return super.status();
      const status = this.legacy.status();
      return { ...status, enabled: super.status().enabled, rollbackAvailable: false,
        ...(status.phase === "installed" ? { message: "Existing pinned tunnel tool verified and adopted in place. Private configuration is preserved; new installations belong to AI Dungeon Master." } : {}) };
    } catch {
      return { ...super.status(), phase: "error", errorCode: "storage", rollbackAvailable: false, message: this.unsafeAdoption().message };
    }
  }
  override async install(authorized: () => boolean, signal: AbortSignal): Promise<TunnelToolStatus> {
    if (this.useLegacy()) {
      const current = this.status();
      if (!current.enabled || !authorized() || signal.aborted) throw new TunnelInstallError("disabled", "Enable downloads and retain the verified GM connection before installation.");
      if (current.phase === "installed") { this.verifiedExecutablePath(); return current; }
      // A broken or unknown receipt needs review, never an implicit migration.
      if (current.phase === "error") throw new TunnelInstallError("storage", "Existing legacy tool verification failed; it was preserved for local review.");
    }
    return super.install(authorized, signal);
  }
  override async rollback(authorized: () => boolean, signal: AbortSignal): Promise<TunnelToolStatus> {
    if (this.useLegacy()) throw new TunnelInstallError("storage", "The adopted legacy installation is read-only. Its original files were preserved.");
    return super.rollback(authorized, signal);
  }
}
