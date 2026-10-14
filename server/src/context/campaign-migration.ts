import { constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, copyFileSync, writeFileSync, rmdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { createHash } from "node:crypto";
import type { CampaignStorageAuthority } from "./campaign-storage.js";
import { hashText } from "./hash.js";
import { assertProtectedCampaignRoot, type ProtectedCampaignOptions } from "./protected-campaign.js";
import { worldCampaignRoot } from "./world-campaign.js";
export interface CampaignMigrationManifest {
  schemaVersion: 1; worldId: string;
  files: Array<{ path: string; revision: string; bytes: number }>;
  manifestRevision: string; blockers: string[];
  excludedAssets: number; originalPublicCopiesRemain: true;
}
const assets = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp4", ".webm", ".mp3", ".ogg", ".wav"]);
function digest(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw new Error("Migration source exceeds file budget or redirects.");
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size || bytes.length > 4_194_304) throw new Error("Migration file changed during read.");
  return createHash("sha256").update(bytes).digest("hex");
}
function segment(value: string): void {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_. -]*$/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw new Error("Migration path invalid.");
}
/** Operator-only dry run. Filenames in this manifest are private, never panel/log data. */
export function planCampaignMigration(worldsRoot: string, worldId: string, options: ProtectedCampaignOptions, authority: CampaignStorageAuthority, signal: AbortSignal): CampaignMigrationManifest {
  signal.throwIfAborted(); authority.authorize(worldId); assertProtectedCampaignRoot(options);
  const source = worldCampaignRoot(worldsRoot, worldId);
  const files: CampaignMigrationManifest["files"] = [], blockers: string[] = [];
  let visited = 0, total = 0, excludedAssets = 0;
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > 12) throw new Error("Migration directory depth exceeds budget.");
    for (const entry of readdirSync(directory).sort()) {
      signal.throwIfAborted(); authority.authorize(worldId);
      if (++visited > 4096) throw new Error("Migration entry budget exceeded.");
      const path = join(directory, entry), stats = lstatSync(path), relative = prefix + entry;
      if (stats.isSymbolicLink() || realpathSync(path) !== path) throw new Error("Migration source redirects.");
      if (entry === ".write-lock" || entry === ".transaction.json" || entry.endsWith(".pending")) throw new Error("Migration source has active transaction.");
      if (stats.isDirectory()) { segment(entry); walk(path, relative + "/", depth + 1); continue; }
      if (assets.has(extname(entry).toLowerCase())) { excludedAssets++; continue; }
      if (!entry.startsWith(".receipt-")) segment(entry);
      if (!stats.isFile()) { blockers.push("Unsupported non-file artifact"); continue; }
      if (stats.size > 4_194_304 || files.length >= 2048 || (total += stats.size) > 33_554_432) throw new Error("Migration source budget exceeded.");
      files.push({ path: relative, revision: digest(path), bytes: stats.size });
    }
  };
  walk(source, "", 0); authority.authorize(worldId); signal.throwIfAborted();
  return { schemaVersion: 1, worldId, files, blockers, excludedAssets, originalPublicCopiesRemain: true,
    manifestRevision: hashText(JSON.stringify({ worldId, files, blockers, excludedAssets })) };
}
/** Explicit copy-only invocation requires a reviewed dry-run revision. Copied scripts are never executed. */
export function copyCampaignMigration(worldsRoot: string, worldId: string, options: ProtectedCampaignOptions, authority: CampaignStorageAuthority, signal: AbortSignal, expectedManifestRevision: string): CampaignMigrationManifest {
  const manifest = planCampaignMigration(worldsRoot, worldId, options, authority, signal);
  if (manifest.manifestRevision !== expectedManifestRevision) throw new Error("Migration source revision changed.");
  if (manifest.blockers.length || !manifest.files.length) throw new Error("Migration has unsupported artifacts or no files.");
  const source = worldCampaignRoot(worldsRoot, worldId), protectedRoot = assertProtectedCampaignRoot(options);
  const destination = join(protectedRoot, worldId, "data", "campaign"); segment(worldId);
  if (existsSync(destination)) throw new Error("Migration cannot overwrite existing destination.");
  const checkedMkdir = (target: string): void => {
    if (target === protectedRoot) return;
    checkedMkdir(dirname(target));
    if (!existsSync(target)) mkdirSync(target);
    if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) throw new Error("Migration destination redirects.");
  };
  signal.throwIfAborted(); authority.authorize(worldId); checkedMkdir(destination);
  const lock = join(destination, ".write-lock"); mkdirSync(lock);
  // Failure/cancellation retains marker and copies; context reads fail closed for operator recovery.
  for (const file of manifest.files) {
    signal.throwIfAborted(); authority.authorize(worldId); assertProtectedCampaignRoot(options);
    const from = join(source, ...file.path.split("/")), target = join(destination, ...file.path.split("/"));
    if (lstatSync(from).isSymbolicLink() || realpathSync(from) !== from || digest(from) !== file.revision) throw new Error("Migration source revision changed.");
    checkedMkdir(dirname(target)); copyFileSync(from, target, constants.COPYFILE_EXCL);
    if (digest(target) !== file.revision) throw new Error("Migration copy verification failed.");
  }
  const after = planCampaignMigration(worldsRoot, worldId, options, authority, signal);
  if (after.manifestRevision !== manifest.manifestRevision) throw new Error("Migration source changed during copy.");
  signal.throwIfAborted(); authority.authorize(worldId);
  writeFileSync(join(destination, ".migration-manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  rmdirSync(lock);
  return manifest;
}
