import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CampaignSourceRepository, type CampaignSourceFile } from "../context/campaign-source.js";
import { hashText } from "../context/hash.js";

export interface InventoryCaller { worldId: string; audience: "gm" | "player" }
export interface SourceInventoryEntry {
  path: string;
  format: string;
  status: "supported" | "unsupported" | "oversize" | "unreadable" | "symlink" | "derived";
  bytes?: number;
}
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
};
/** Authenticated GM-only protected-root inventory. Metadata snapshots are reused between
 * pages; explicit refresh invalidates cursors. No file content read during inventory. */
export class PreparationSourceInventory {
  private snapshot: { entries: SourceInventoryEntry[]; revision: string } | null = null;
  private readonly root: string;
  private readonly repository: CampaignSourceRepository;
  constructor(private readonly worldId: string, protectedCampaignRoot: string,
    private readonly authorize: (caller: InventoryCaller) => void) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(worldId)) throw Error("Invalid world identity");
    this.root = realpathSync(protectedCampaignRoot);
    this.repository = new CampaignSourceRepository([{ rootId: worldId, path: this.root }]);
  }
  private check(caller: InventoryCaller) {
    this.authorize(caller);
    if (caller.worldId !== this.worldId || caller.audience !== "gm") throw Error("Preparation source access denied");
  }
  list(caller: InventoryCaller, options: { cursor?: string | undefined; limit?: number | undefined; refresh?: boolean | undefined } = {}) {
    this.check(caller);
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32 || (options.refresh && options.cursor)) throw Error("Inventory page budget");
    if (!this.snapshot || options.refresh) {
      const entries: SourceInventoryEntry[] = [];
      const watermarks: string[] = [];
      let visited = 0;
      const walk = (directory: string, prefix = "") => {
        let children;
        try { children = readdirSync(directory, { withFileTypes: true }); }
        catch { entries.push({ path: prefix || ".", format: "directory", status: "unreadable" }); return; }
        for (const child of children.sort((a,b) => a.name.localeCompare(b.name))) {
          if (++visited > 512) throw Error("Inventory entry budget exceeded");
          const path = prefix + child.name;
          const lexical = join(directory, child.name);
          const format = child.name.split(".").slice(1).pop()?.toLowerCase() ?? "unknown";
          if (child.isSymbolicLink()) { entries.push({ path, format, status: "symlink" }); continue; }
          if (child.isDirectory()) {
            if (["preparation", "node_modules", ".git", "__pycache__"].includes(child.name)) { entries.push({ path, format: "directory", status: "derived" }); continue; }
            if (!inside(this.root, realpathSync(lexical))) throw Error("Inventory root redirect");
            walk(lexical, path + "/"); continue;
          }
          try {
            const stat = lstatSync(lexical);
            watermarks.push(`${path}:${stat.size}:${stat.mtimeMs}`);
            entries.push({ path, format, bytes: stat.size,
              status: format !== "md" ? "unsupported" : stat.size > 512000 ? "oversize" : "supported" });
          } catch { entries.push({ path, format, status: "unreadable" }); }
        }
      };
      if (resolve(realpathSync(this.root)) !== resolve(this.root)) throw Error("Inventory root redirect");
      walk(this.root);
      this.snapshot = { entries, revision: hashText(JSON.stringify([entries, watermarks])) };
    }
    const snapshot = this.snapshot;
    let offset = 0;
    if (options.cursor) {
      const parts = /^([a-f0-9]{64}):(\d{1,4})$/.exec(options.cursor);
      if (!parts || parts[1] !== snapshot.revision) throw Error("Stale inventory cursor");
      offset = Number(parts[2]);
      if (offset > snapshot.entries.length) throw Error("Invalid inventory cursor");
    }
    const entries = snapshot.entries.slice(offset, offset + limit);
    const facets = Object.fromEntries(["supported", "unsupported", "oversize", "unreadable", "symlink", "derived"].map(status => [status, snapshot.entries.filter(e => e.status === status).length]));
    this.check(caller);
    return { worldId: this.worldId, revision: snapshot.revision, entries, facets,
      continuation: offset + entries.length < snapshot.entries.length ? `${snapshot.revision}:${offset + entries.length}` : null };
  }
  load(caller: InventoryCaller, paths: readonly string[]): CampaignSourceFile[] {
    this.check(caller);
    if (!paths.length || paths.length > 32 || new Set(paths.map(p => p.toLowerCase())).size !== paths.length) throw Error("Selected source budget or duplicate conflict");
    const sources = paths.map(path => {
      const source = this.repository.load(this.worldId, path);
      let selected = this.root;
      for (const segment of path.replaceAll("\\", "/").split("/")) {
        if (["preparation", "node_modules", ".git", "__pycache__"].includes(segment)) throw Error("Derived source not admitted");
        selected = join(selected, segment);
        if (lstatSync(selected).isSymbolicLink()) throw Error("Source redirect not admitted");
      }
      return source;
    });
    this.check(caller);
    return sources;
  }
}
