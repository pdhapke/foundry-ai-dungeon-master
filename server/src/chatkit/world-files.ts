import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";

export interface WorldFileRequest {
  requestId: string;
  operation: "write" | "mkdir" | "delete" | "recover";
  path: string;
  expectedRevision: string | null;
  encoding?: "utf8" | "base64";
  content?: string;
}
export interface WorldFileAuthority {
  /** Verify current authenticated GM, active world and revocation; never infer from model text. */
  authorize(identity: AiDmAuthenticatedIdentity): Promise<void>;
  assertPrivateStorage?(worldId: string): Promise<void>;
  /** Server-only exact current human intent authorization. A permissive implementation is unsafe. */
  authorizeWriteIntent?(
    identity: AiDmAuthenticatedIdentity,
    request: Readonly<WorldFileRequest>,
    digest: string,
  ): Promise<void>;
  /** Separate exact human review of destructive content/path/revision; no model approval flags. */
  authorizeDeleteIntent?(
    identity: AiDmAuthenticatedIdentity,
    request: Readonly<WorldFileRequest>,
    digest: string,
  ): Promise<void>;
}
export interface WorldFileReceipt {
  worldId: string;
  requestId: string;
  operation: string;
  path: string;
  status: "completed" | "recovered";
  revision: string | null;
  requestDigest: string;
}
export interface WorldFileIntent {
  readonly intentDigest: string;
}
interface Pending {
  request: WorldFileRequest;
  before: string | null;
  after: string | null;
  createdDirectories: string[];
  receipt: WorldFileReceipt;
}
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const inside = (root: string, target: string) => {
  const p = relative(root, target);
  return p === "" || (!isAbsolute(p) && p !== ".." && !p.startsWith(`..${sep}`));
};
const protectedRoots = new Set(["packs", ".runtime", ".git", "node_modules"]);
const databaseNames = new Set([
  "actors",
  "cards",
  "combats",
  "fog",
  "items",
  "journal",
  "macros",
  "playlists",
  "scenes",
  "settings",
  "users",
]);
function pathParts(path: string, allowRoot = false): string[] {
  if (allowRoot && path === "") return [];
  if (!path || path.length > 500 || isAbsolute(path) || path.includes("\\"))
    throw new Error("Invalid relative world path");
  const parts = path.split("/");
  for (const p of parts)
    if (
      !p ||
      p === "." ||
      p === ".." ||
      /[<>:"|?*]/.test(p) ||
      [...p].some((c) => c.charCodeAt(0) < 32) ||
      /[. ]$/.test(p) ||
      /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p) ||
      p.toLowerCase().includes(".ai-dm-world-")
    )
      throw new Error("Invalid world path segment");
  const lower = parts.map((p) => p.toLowerCase());
  if (
    protectedRoots.has(lower[0]!) ||
    lower[0] === "world.json" ||
    lower.some(
      (p) => /^\.env(?:\.|$)/.test(p) || /^(?:credentials|secrets|auth)(?:\.|$)/.test(p),
    ) ||
    (lower[0] === "data" && databaseNames.has(lower[1] ?? "")) ||
    /\.(?:db|sqlite|sqlite3|db-journal|db-wal|db-shm|log|ldb|lock|pem|key|pfx|p12|js|mjs|cjs|ts|py|ps1|bat|cmd|exe|dll|sh)$/i.test(
      path,
    )
  )
    throw new Error("World runtime/credential/code path requires its supported Foundry API");
  return parts;
}

/** Authored world files only. Local administrators must not race directory replacement:
 * Node on Windows cannot provide openat-style race-free ancestor containment. */
export class WorldFiles {
  private readonly root: string;
  private readonly intents = new WeakMap<
    WorldFileIntent,
    { identity: AiDmAuthenticatedIdentity; request: WorldFileRequest }
  >();
  constructor(
    worldsRoot: string,
    readonly db: DatabaseSync,
    private readonly authority: WorldFileAuthority,
    private readonly maxBytes = 1_048_576,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4_194_304)
      throw new Error("Invalid world-file budget");
    this.root = realpathSync(worldsRoot);
    db.exec(
      "CREATE TABLE IF NOT EXISTS chatkit_world_files(scope_key TEXT PRIMARY KEY,world TEXT NOT NULL,owner TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,journal_json TEXT,receipt_json TEXT)",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS chatkit_world_files_pending_world ON chatkit_world_files(world) WHERE state='pending'",
    );
  }
  private async auth(identity: AiDmAuthenticatedIdentity, write = false): Promise<string> {
    if (!identity.isGm || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.worldId) || !identity.userId)
      throw new Error("Current GM world required");
    await this.authority.authorize(identity);
    if (write) {
      if (!this.authority.assertPrivateStorage)
        throw new Error(
          "Private world-file persistence is disabled until deployment privacy is verified",
        );
      await this.authority.assertPrivateStorage(identity.worldId);
      // Privacy verification may await external work. Recheck live authority
      // after it returns so a cancelled/revoked operation cannot resume effects.
      await this.authority.authorize(identity);
    }
    const world = join(this.root, identity.worldId);
    this.check(world);
    if (!statSync(world).isDirectory()) throw new Error("World folder missing");
    return world;
  }
  private check(path: string): void {
    if (
      !inside(this.root, path) ||
      lstatSync(path).isSymbolicLink() ||
      !inside(this.root, realpathSync(path))
    )
      throw new Error("World link/containment escape rejected");
  }
  private target(world: string, path: string, create = false, created: string[] = []): string {
    const parts = pathParts(path);
    let current = world;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      if (!existsSync(current)) {
        // lstat catches a dangling link; existsSync alone must not treat it as missing.
        try {
          lstatSync(current);
          throw new Error("Dangling world link rejected");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (i < parts.length - 1) {
          if (!create) return join(current, ...parts.slice(i + 1));
          mkdirSync(current);
          created.push(parts.slice(0, i + 1).join("/"));
        } else return current;
      }
      this.check(current);
      if (i < parts.length - 1 && !statSync(current).isDirectory())
        throw new Error("Parent is not a folder");
    }
    return current;
  }
  private bytes(target: string): Buffer | null {
    if (!existsSync(target)) return null;
    this.check(target);
    if (!statSync(target).isFile() || statSync(target).size > this.maxBytes)
      throw new Error("File unavailable or exceeds byte budget");
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = readFileSync(fd);
      if (bytes.length > this.maxBytes) throw new Error("File exceeds byte budget");
      return bytes;
    } finally {
      closeSync(fd);
    }
  }
  private ensureNoPending(worldId: string): void {
    if (
      this.db
        .prepare("SELECT 1 FROM chatkit_world_files WHERE world=? AND state='pending'")
        .get(worldId)
    )
      throw new Error("World-file recovery required");
  }
  async list(
    identity: AiDmAuthenticatedIdentity,
    path = "",
    after = "",
    limit = 50,
  ): Promise<{
    entries: { name: string; kind: "file" | "directory"; bytes: number }[];
    next: string | null;
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid list limit");
    const world = await this.auth(identity);
    this.ensureNoPending(identity.worldId);
    const target = path === "" ? world : this.target(world, path);
    pathParts(path, true);
    this.check(target);
    const entries = [];
    const names = readdirSync(target)
      .sort()
      .filter((n) => n > after);
    let next: string | null = null;
    for (const name of names) {
      try {
        pathParts(path ? `${path}/${name}` : name);
        const p = join(target, name);
        this.check(p);
        const s = statSync(p);
        if (!s.isFile() && !s.isDirectory()) continue;
        if (entries.length === limit) {
          next = entries.at(-1)!.name;
          break;
        }
        entries.push({
          name,
          kind: s.isDirectory() ? ("directory" as const) : ("file" as const),
          bytes: s.size,
        });
      } catch {
        continue;
      }
    }
    await this.auth(identity);
    return { entries, next };
  }
  async read(
    identity: AiDmAuthenticatedIdentity,
    path: string,
    encoding: "utf8" | "base64" | "metadata" = "metadata",
  ): Promise<{
    path: string;
    bytes: number;
    revision: string | null;
    encoding: string;
    content?: string;
  }> {
    if (!["utf8", "base64", "metadata"].includes(encoding))
      throw new Error("Explicit supported encoding required");
    const world = await this.auth(identity);
    this.ensureNoPending(identity.worldId);
    const target = this.target(world, path);
    this.check(target);
    const s = statSync(target);
    if (!s.isFile()) throw new Error("File required");
    if (encoding === "metadata") {
      await this.auth(identity);
      return {
        path,
        bytes: s.size,
        revision: s.size > this.maxBytes ? null : this.metadataHash(target),
        encoding,
      };
    }
    if (s.size > 12_000)
      throw new Error(
        "Context read exceeds 12k byte budget; use metadata or authored smaller sections",
      );
    const bytes = this.bytes(target)!;
    const content =
      encoding === "base64"
        ? bytes.toString("base64")
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    await this.auth(identity);
    return { path, bytes: bytes.length, revision: hash(bytes), encoding, content };
  }
  private metadataHash(target: string): string {
    const bytes = this.bytes(target);
    if (bytes) return hash(bytes);
    throw new Error("File missing");
  }
  private normalize(request: WorldFileRequest): WorldFileRequest {
    if (
      !request ||
      Object.keys(request).some(
        (k) =>
          !["requestId", "operation", "path", "expectedRevision", "encoding", "content"].includes(
            k,
          ),
      ) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(request.requestId) ||
      !["write", "mkdir", "delete", "recover"].includes(request.operation)
    )
      throw new Error("Invalid world-file request");
    pathParts(request.path);
    if (request.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(request.expectedRevision))
      throw new Error("Expected SHA-256 revision required");
    if (request.operation === "write") {
      if (
        typeof request.content !== "string" ||
        !["utf8", "base64"].includes(request.encoding ?? "")
      )
        throw new Error("Explicit write encoding required");
      this.decode(request);
    } else if (request.content !== undefined || request.encoding !== undefined)
      throw new Error("Unexpected content");
    return structuredClone(request);
  }
  private decode(request: WorldFileRequest): Buffer {
    if (request.content!.length > this.maxBytes * 2) throw new Error("Write exceeds budget");
    if (
      request.encoding === "base64" &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.content!)
    )
      throw new Error("Invalid base64");
    const bytes = Buffer.from(request.content!, request.encoding === "base64" ? "base64" : "utf8");
    if (bytes.length > this.maxBytes) throw new Error("Write exceeds budget");
    return bytes;
  }
  async issueIntent(
    identity: AiDmAuthenticatedIdentity,
    request: WorldFileRequest,
  ): Promise<WorldFileIntent> {
    const value = this.normalize(request);
    await this.auth(identity, true);
    const digest = hash(JSON.stringify(value));
    const authorize =
      value.operation === "delete"
        ? this.authority.authorizeDeleteIntent?.bind(this.authority)
        : this.authority.authorizeWriteIntent?.bind(this.authority);
    if (!authorize) throw new Error("Trusted exact human write/review authorization unavailable");
    await authorize(identity, Object.freeze(structuredClone(value)), digest);
    await this.auth(identity, true);
    const intent = Object.freeze({ intentDigest: digest });
    this.intents.set(intent, { identity: structuredClone(identity), request: value });
    return intent;
  }
  private atomic(target: string, bytes: Buffer, requestId: string): void {
    const staging = `${target}.ai-dm-world-${requestId}`;
    if (existsSync(staging)) throw new Error("Unexpected staging file");
    const fd = openSync(staging, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staging, target);
  }
  async apply(
    identity: AiDmAuthenticatedIdentity,
    intent: WorldFileIntent,
  ): Promise<WorldFileReceipt> {
    const trusted = this.intents.get(intent);
    if (
      !trusted ||
      trusted.identity.worldId !== identity.worldId ||
      trusted.identity.userId !== identity.userId ||
      trusted.identity.clientId !== identity.clientId
    )
      throw new Error("Server-issued scoped intent required");
    const request = trusted.request;
    const world = await this.auth(identity, true);
    const key = JSON.stringify([identity.worldId, identity.userId, request.requestId]);
    const prior = this.db.prepare("SELECT * FROM chatkit_world_files WHERE scope_key=?").get(key);
    if (prior) {
      if (prior["digest"] !== intent.intentDigest) throw new Error("Request ID conflict");
      if (prior["state"] !== "completed")
        throw new Error("Uncertain world write requires recovery; never retry");
      return JSON.parse(String(prior["receipt_json"])) as WorldFileReceipt;
    }
    if (request.operation === "recover") return this.recover(identity, intent);
    this.ensureNoPending(identity.worldId);
    const created: string[] = [];
    const target = this.target(world, request.path, false);
    let before: Buffer | null = null;
    const planned = request.path.split("/");
    for (let i = 1; i < planned.length; i++) {
      const path = planned.slice(0, i).join("/");
      if (!existsSync(this.target(world, path))) created.push(path);
    }
    if (request.operation === "mkdir") {
      if (request.expectedRevision !== null || existsSync(target))
        throw new Error("Folder already exists or revision invalid");
    } else {
      before = this.bytes(target);
      if ((before ? hash(before) : null) !== request.expectedRevision)
        throw new Error("Stale world-file revision");
      if (request.operation === "delete" && !before) throw new Error("Delete target missing");
    }
    const after = request.operation === "write" ? this.decode(request) : null;
    const receipt: WorldFileReceipt = {
      worldId: identity.worldId,
      requestId: request.requestId,
      operation: request.operation,
      path: request.path,
      status: "completed",
      revision: after ? hash(after) : null,
      requestDigest: intent.intentDigest,
    };
    const pending: Pending = {
      request,
      before: before?.toString("base64") ?? null,
      after: after?.toString("base64") ?? null,
      createdDirectories: created,
      receipt,
    };
    // SQLite claim precedes filesystem effects. No awaited gap after final live authority check.
    await this.auth(identity, true);
    const refreshed = this.target(world, request.path);
    if (request.operation === "mkdir") {
      if (existsSync(refreshed)) throw new Error("Folder appeared before dispatch");
    } else if (
      (this.bytes(refreshed) ? hash(this.bytes(refreshed)!) : null) !== request.expectedRevision
    )
      throw new Error("Stale revision before dispatch");
    this.db
      .prepare("INSERT INTO chatkit_world_files VALUES(?,?,?,?,?,?,?)")
      .run(
        key,
        identity.worldId,
        identity.userId,
        intent.intentDigest,
        "pending",
        JSON.stringify(pending),
        null,
      );
    try {
      const destination = this.target(world, request.path, true);
      if (request.operation === "write") this.atomic(destination, after!, request.requestId);
      else if (request.operation === "delete") unlinkSync(destination);
      else mkdirSync(destination);
      if (request.operation === "write" && hash(this.bytes(destination)!) !== receipt.revision)
        throw new Error("World write verification failed");
      if (request.operation === "delete" && existsSync(destination))
        throw new Error("Delete read-back mismatch");
      if (request.operation === "mkdir") {
        this.check(destination);
        if (!statSync(destination).isDirectory()) throw new Error("Folder read-back mismatch");
      }
      await this.auth(identity, true);
      this.db
        .prepare(
          "UPDATE chatkit_world_files SET state='completed',receipt_json=?,journal_json=NULL WHERE scope_key=?",
        )
        .run(JSON.stringify(receipt), key);
      return receipt;
    } catch {
      throw new Error("World-file effect unresolved; inspect and recover, do not retry");
    }
  }
  private async recover(
    identity: AiDmAuthenticatedIdentity,
    intent: WorldFileIntent,
  ): Promise<WorldFileReceipt> {
    const request = this.intents.get(intent)!.request;
    const world = await this.auth(identity, true);
    const rows = this.db
      .prepare("SELECT * FROM chatkit_world_files WHERE world=? AND owner=? AND state='pending'")
      .all(identity.worldId, identity.userId);
    const row = rows.find((r) => {
      const p = JSON.parse(String(r["journal_json"])) as Pending;
      return p.request.path === request.path;
    });
    if (!row) throw new Error("No scoped recovery target");
    const journal = JSON.parse(String(row["journal_json"])) as Pending;
    this.normalize(journal.request);
    if (
      (journal.before?.length ?? 0) > this.maxBytes * 2 ||
      (journal.after?.length ?? 0) > this.maxBytes * 2
    )
      throw new Error("Recovery exceeds byte budget");
    const target = this.target(world, request.path);
    const current = journal.request.operation === "mkdir" ? null : this.bytes(target);
    const before = journal.before === null ? null : Buffer.from(journal.before, "base64"),
      after = journal.after === null ? null : Buffer.from(journal.after, "base64");
    if (request.expectedRevision !== (current ? hash(current) : null))
      throw new Error("Recovery revision changed");
    if (
      journal.request.operation !== "mkdir" &&
      current &&
      hash(current) !== (before ? hash(before) : null) &&
      hash(current) !== (after ? hash(after) : null)
    )
      throw new Error("Unknown content blocks recovery");
    await this.auth(identity, true);
    if (journal.request.operation !== "mkdir") {
      const refreshed = this.bytes(this.target(world, request.path));
      if ((refreshed ? hash(refreshed) : null) !== request.expectedRevision)
        throw new Error("Recovery revision changed before dispatch");
    }
    const staging = `${target}.ai-dm-world-${journal.request.requestId}`;
    if (existsSync(staging)) {
      this.check(staging);
      if (!after || hash(this.bytes(staging)!) !== hash(after))
        throw new Error("Unknown staging content blocks recovery");
      unlinkSync(staging);
    }
    if (journal.request.operation === "mkdir") {
      if (existsSync(target)) {
        this.check(target);
        rmdirSync(target);
      }
    } else if (before) this.atomic(target, before, request.requestId);
    else if (existsSync(target)) unlinkSync(target);
    for (const path of [...journal.createdDirectories].reverse()) {
      const dir = this.target(world, path);
      if (existsSync(dir)) {
        this.check(dir);
        if (!readdirSync(dir).length) rmdirSync(dir);
      }
    }
    await this.auth(identity, true);
    const receipt = {
      ...journal.receipt,
      requestId: request.requestId,
      operation: "recover",
      status: "recovered" as const,
      revision: before ? hash(before) : null,
      requestDigest: intent.intentDigest,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE chatkit_world_files SET state='recovered',receipt_json=?,journal_json=NULL WHERE scope_key=?",
        )
        .run(JSON.stringify(receipt), row["scope_key"] as string);
      this.db
        .prepare("INSERT INTO chatkit_world_files VALUES(?,?,?,?,?,?,?)")
        .run(
          JSON.stringify([identity.worldId, identity.userId, request.requestId]),
          identity.worldId,
          identity.userId,
          intent.intentDigest,
          "completed",
          null,
          JSON.stringify(receipt),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return receipt;
  }
}
