import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { hashText } from "./hash.js";
import { assertProtectedCampaignRoot, type ProtectedCampaignOptions } from "./protected-campaign.js";

export interface CampaignStorageAuthority {
  /** Must revalidate the live Foundry capability, including revocation, on every call. */
  authorize(worldId: string): void;
  /** Server-owned deployment verification. Defaults to denying all private writes. */
  assertPrivateStorage?: (worldId: string) => void;
}
export interface CampaignFileEdit {
  path: string;
  expectedRevision: string | null;
  text: string;
}
export interface CampaignFile {
  path: string;
  text: string;
  revision: string;
}
export interface CampaignCommitReceipt {
  worldId: string;
  files: { path: string; revision: string }[];
  transactionId?: string;
  batchDigest?: string;
}
interface Journal {
  version: 1;
  worldId: string;
  before: { path: string; text: string | null }[];
  transaction?: { transactionId: string; batchDigest: string };
}

function segment(value: string): void {
  if (
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_. -]*$/.test(value) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error("Invalid campaign path segment.");
}
function filePath(value: string): string {
  if (value.includes("\\") || isAbsolute(value) || !value.endsWith(".md") || value.length > 200)
    throw new Error("Invalid campaign Markdown path.");
  value.split("/").forEach(segment);
  return value;
}
function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function existsEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Construct only from trusted server configuration; never pass browser/model filesystem roots.
 * Local administrators must not modify campaign directories concurrently: Node cannot provide
 * openat-style race-free containment on Windows. All cooperative writers use this repository.
 */
export class CampaignStorage {
  private readonly root: string;
  private readonly maxJournalBytes: number;
  constructor(
    worldsRoot: string,
    private readonly authority: CampaignStorageAuthority,
    private readonly maxFileBytes = 128_000,
    private readonly maxBatchBytes = 512_000,
    private readonly protectedOptions?: ProtectedCampaignOptions,
  ) {
    if (
      !Number.isSafeInteger(maxFileBytes) ||
      maxFileBytes < 1 ||
      maxFileBytes > 1_048_576 ||
      !Number.isSafeInteger(maxBatchBytes) ||
      maxBatchBytes < 1 ||
      maxBatchBytes > 33_554_432
    )
      throw new Error("Invalid campaign storage budgets.");
    // JSON can expand one UTF-8 control byte to six ASCII bytes (\\u0000).
    // Old snapshots are bounded per file, independently of the *new* batch budget.
    // Include 32 resource names, a bounded world id, and structural overhead.
    this.maxJournalBytes = 32 * (6 * maxFileBytes + 6 * 200 + 64) + 6 * 200 + 128;
    this.root = protectedOptions ? assertProtectedCampaignRoot(protectedOptions) : realpathSync(worldsRoot);
  }
  private campaign(worldId: string, create: boolean): string {
    if (worldId.length > 200) throw new Error("Invalid campaign world identifier.");
    segment(worldId);
    this.authority.authorize(worldId);
    if (this.protectedOptions) assertProtectedCampaignRoot(this.protectedOptions);
    const world = this.checked(this.root, worldId, Boolean(this.protectedOptions && create));
    if (!statSync(world).isDirectory())
      throw new Error("Authorized world directory does not exist.");
    const data = this.checked(world, "data", create);
    return this.checked(data, "campaign", create);
  }
  private checked(root: string, path: string, create: boolean): string {
    let current = root;
    for (const part of path.split("/")) {
      segment(part);
      current = join(current, part);
      if (!existsEntry(current)) {
        if (!create) throw new Error("Campaign path does not exist.");
        mkdirSync(current);
      }
      if (lstatSync(current).isSymbolicLink() || !contained(root, realpathSync(current)))
        throw new Error("Campaign link or containment escape rejected.");
    }
    return current;
  }
  private target(root: string, path: string, create: boolean): string {
    filePath(path);
    const parts = path.split("/");
    const name = parts.pop()!;
    const directory = parts.length ? this.checked(root, parts.join("/"), create) : root;
    const target = join(directory, name);
    if (
      existsEntry(target) &&
      (lstatSync(target).isSymbolicLink() ||
        !contained(root, realpathSync(target)) ||
        !statSync(target).isFile())
    )
      throw new Error("Campaign target escape rejected.");
    return target;
  }
  private readTarget(target: string): string | null {
    if (!existsSync(target)) return null;
    if (statSync(target).size > this.maxFileBytes) throw new Error("Campaign file exceeds budget.");
    const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const text = readFileSync(fd, "utf8");
      if (Buffer.byteLength(text) > this.maxFileBytes)
        throw new Error("Campaign file exceeds budget.");
      return text;
    } finally {
      closeSync(fd);
    }
  }
  read(worldId: string, path: string): CampaignFile | null {
    const root = this.campaign(worldId, false);
    if (existsSync(join(root, ".transaction.json")) || existsSync(join(root, ".write-lock")))
      throw new Error("Campaign recovery required before reading.");
    const text = this.readTarget(this.target(root, path, false));
    this.authority.authorize(worldId);
    return text === null ? null : { path, text, revision: hashText(text) };
  }
  /** Authorized metadata only: invalidate disposable preparation caches without
   * rereading every immutable version record. Content hashes remain authoritative on rebuild. */
  fingerprint(worldId:string,paths:readonly string[]):string {
    if(paths.length>512||new Set(paths).size!==paths.length)throw Error('Campaign metadata budget');
    const root=this.campaign(worldId,false);
    if(existsSync(join(root,'.transaction.json'))||existsSync(join(root,'.write-lock')))throw Error('Campaign recovery required before reading.');
    const rows=paths.map(path=>{
      const target=this.target(root,path,false);
      if(!existsEntry(target))return[path,null];
      const stat=statSync(target,{bigint:true});
      return[path,stat.size.toString(),stat.mtimeNs.toString(),stat.ctimeNs.toString(),stat.ino.toString()];
    });
    this.authority.authorize(worldId);return hashText(JSON.stringify(rows));
  }
  private atomic(target: string, text: string): void {
    const temporary = `${target}.pending`;
    if (existsEntry(temporary)) throw new Error("Unexpected campaign staging file.");
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  }
  private privateWrite(worldId: string): void {
    if (this.protectedOptions) {
      assertProtectedCampaignRoot(this.protectedOptions);
      this.authority.assertPrivateStorage?.(worldId);
      return;
    }
    if (!this.authority.assertPrivateStorage)
      throw new Error("Private campaign storage deployment is not verified.");
    this.authority.assertPrivateStorage(worldId);
  }
  receipt(worldId: string, transactionId: string): CampaignCommitReceipt | null {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)) throw new Error("Invalid transaction ID.");
    const root = this.campaign(worldId, false);
    const path = join(root, `.receipt-${transactionId}.json`);
    if (!existsEntry(path)) return null;
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > 16_000)
      throw new Error("Invalid campaign receipt.");
    const receipt = JSON.parse(readFileSync(path, "utf8")) as CampaignCommitReceipt;
    if (
      receipt.worldId !== worldId ||
      receipt.transactionId !== transactionId ||
      !Array.isArray(receipt.files) ||
      receipt.files.length > 32 ||
      !/^[a-f0-9]{64}$/.test(receipt.batchDigest ?? "")
    )
      throw new Error("Invalid campaign receipt.");
    for (const file of receipt.files) {
      filePath(file.path);
      if (!/^[a-f0-9]{64}$/.test(file.revision))
        throw new Error("Invalid campaign receipt revision.");
    }
    this.authority.authorize(worldId);
    return receipt;
  }
  commit(
    worldId: string,
    edits: readonly CampaignFileEdit[],
    transaction?: { transactionId: string; batchDigest: string },
  ): CampaignCommitReceipt {
    this.privateWrite(worldId);
    if (
      !edits.length ||
      edits.length > 32 ||
      new Set(edits.map((e) => e.path.toLowerCase())).size !== edits.length ||
      edits.reduce((n, e) => n + Buffer.byteLength(e.text), 0) > this.maxBatchBytes
    )
      throw new Error("Invalid campaign batch or budget.");
    edits.forEach((e) => {
      filePath(e.path);
      if (Buffer.byteLength(e.text) > this.maxFileBytes)
        throw new Error("Campaign file exceeds budget.");
    });
    const root = this.campaign(worldId, true);
    if (transaction) {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(transaction.transactionId) ||
        !/^[a-f0-9]{64}$/.test(transaction.batchDigest)
      )
        throw new Error("Invalid campaign transaction.");
      const existing = this.receipt(worldId, transaction.transactionId);
      if (existing) {
        if (
          existing.batchDigest !== transaction.batchDigest ||
          JSON.stringify(existing.files) !==
            JSON.stringify(edits.map((e) => ({ path: e.path, revision: hashText(e.text) })))
        )
          throw new Error("Campaign transaction conflict.");
        return existing;
      }
    }
    const lock = join(root, ".write-lock");
    mkdirSync(lock);
    const journalPath = join(root, ".transaction.json");
    try {
      if (existsSync(journalPath)) throw new Error("Campaign recovery required.");
      const before = edits.map((e) => {
        const text = this.readTarget(this.target(root, e.path, true));
        if ((text === null ? null : hashText(text)) !== e.expectedRevision)
          throw new Error("Campaign revision conflict.");
        return { path: e.path, text };
      });
      this.authority.authorize(worldId);
      this.privateWrite(worldId);
      const serialized = JSON.stringify({
        version: 1,
        worldId,
        before,
        ...(transaction ? { transaction } : {}),
      } satisfies Journal);
      if (Buffer.byteLength(serialized) > this.maxJournalBytes)
        throw new Error("Campaign journal exceeds budget.");
      this.atomic(journalPath, serialized);
      for (const edit of edits) {
        this.authority.authorize(worldId);
        this.privateWrite(worldId);
        this.atomic(this.target(root, edit.path, true), edit.text);
      }
      this.authority.authorize(worldId);
      for (const edit of edits)
        if (this.readTarget(this.target(root, edit.path, false)) !== edit.text)
          throw new Error("Campaign write verification failed.");
      const receipt: CampaignCommitReceipt = {
        worldId,
        files: edits.map((e) => ({ path: e.path, revision: hashText(e.text) })),
        ...(transaction ?? {}),
      };
      this.authority.authorize(worldId);
      this.privateWrite(worldId);
      if (transaction)
        this.atomic(
          join(root, `.receipt-${transaction.transactionId}.json`),
          JSON.stringify(receipt),
        );
      rmSync(journalPath);
      return receipt;
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
  /** Explicit recovery after failed commit or restart; rolls incomplete transactions back.
   * A surviving lock requires operator confirmation that its writer process has stopped.
   */
  recover(worldId: string): void {
    this.privateWrite(worldId);
    const root = this.campaign(worldId, false);
    const lock = join(root, ".write-lock");
    mkdirSync(lock);
    try {
      const path = join(root, ".transaction.json");
      if (!existsSync(path)) return;
      if (lstatSync(path).isSymbolicLink() || statSync(path).size > this.maxJournalBytes)
        throw new Error("Invalid recovery journal.");
      const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
      if (
        journal.version !== 1 ||
        journal.worldId !== worldId ||
        !Array.isArray(journal.before) ||
        journal.before.length > 32
      )
        throw new Error("Invalid recovery journal.");
      if (journal.transaction) {
        const receipt = this.receipt(worldId, journal.transaction.transactionId);
        if (receipt) {
          if (receipt.batchDigest !== journal.transaction.batchDigest)
            throw new Error("Recovery receipt conflict.");
          for (const file of receipt.files) {
            const text = this.readTarget(this.target(root, file.path, false));
            if (text === null || hashText(text) !== file.revision)
              throw new Error("Recovery receipt read-back mismatch.");
          }
          rmSync(path);
          return;
        }
      }
      for (const entry of journal.before) {
        this.authority.authorize(worldId);
        this.privateWrite(worldId);
        const target = this.target(root, entry.path, true);
        if (
          entry.text !== null &&
          (typeof entry.text !== "string" || Buffer.byteLength(entry.text) > this.maxFileBytes)
        )
          throw new Error("Invalid recovery content.");
        const staging = `${target}.pending`;
        if (existsSync(staging)) {
          if (lstatSync(staging).isSymbolicLink()) throw new Error("Invalid staging link.");
          rmSync(staging);
        }
        if (entry.text === null) rmSync(target, { force: true });
        else this.atomic(target, entry.text);
      }
      rmSync(path);
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
}
