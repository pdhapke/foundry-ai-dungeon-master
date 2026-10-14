import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { ProtectedCampaignOptions } from "../context/protected-campaign.js";
import { CampaignStorage, type CampaignCommitReceipt } from "../context/campaign-storage.js";
import { hashText, stableJson } from "../context/hash.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const proposalInput = z
  .object({
    proposalId: id,
    title: z.string().min(1).max(120),
    files: z
      .array(
        z
          .object({
            path: z.string().max(200),
            expectedRevision: revision,
            proposedText: z.string().max(16_000),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
type Scope = { worldId: string; userId: string; threadId: string };
type FileReview = {
  path: string;
  expectedRevision: string | null;
  beforeHash: string | null;
  afterHash: string;
  beforeText: string | null;
  proposedText: string;
  beforeCanonStatus: string | null;
  afterCanonStatus: string;
};
type Entry = {
  kind: "campaign";
  schemaVersion: 1;
  proposalId: string;
  title: string;
  scope: Scope;
  batchDigest: string;
  expiresAt: number;
  status:
    | "drafting"
    | "pending"
    | "dispatching"
    | "completed"
    | "rejected"
    | "cancelled"
    | "stale"
    | "uncertain";
  files: FileReview[];
  transactionId: string;
  receipt: AiDmJsonValue | null;
  issue: string | null;
  approval: { userId: string; batchDigest: string; approvedAt: number } | null;
};
export interface CampaignActionsOptions {
  worldsRoot: string;
  protectedCampaign?: ProtectedCampaignOptions;
  assertPrivateStorage?: (worldId: string) => void;
  now?: () => number;
}
function metadata(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Campaign resource requires versioned frontmatter.");
  const output: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (field) {
      if (output[field[1]!] !== undefined) throw new Error("Duplicate campaign metadata.");
      output[field[1]!] = field[2]!;
    }
  }
  if (
    output["schema_version"] !== "1" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(output["id"] ?? "") ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(output["revision"] ?? "") ||
    !["public", "gm", "secret"].includes(output["visibility"] ?? "") ||
    !["draft", "canon"].includes(output["canon_status"] ?? "")
  )
    throw new Error("Invalid campaign resource metadata.");
  return output;
}
function resourcePath(path: string): void {
  if (
    !/^(overview\.md|index\.md|(?:locations|npcs|factions|quests|rules|sessions)\/[A-Za-z0-9_-][A-Za-z0-9_. -]*\.md)$/.test(
      path,
    )
  )
    throw new Error("Unsupported campaign resource path.");
}

/** Durable exact proposals; only authenticated browser decisions can commit canon. */
export class ChatKitCampaignActions {
  constructor(
    private readonly db: DatabaseSync,
    private readonly authorize: (
      identity: AiDmAuthenticatedIdentity,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly options: CampaignActionsOptions,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS chatkit_campaign_proposals (scope_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)",
    );
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private key(scope: Scope, proposalId: string): string {
    return stableJson([scope.worldId, scope.userId, scope.threadId, proposalId]);
  }
  private load(scope: Scope, proposalId: string): Entry | undefined {
    const row = this.db
      .prepare("SELECT entry_json FROM chatkit_campaign_proposals WHERE scope_key=?")
      .get(this.key(scope, proposalId));
    return row ? (JSON.parse(String(row["entry_json"])) as Entry) : undefined;
  }
  private save(entry: Entry, expectedJson: string | null): { won: boolean; entry: Entry } {
    const result = this.db
      .prepare(
        "INSERT INTO chatkit_campaign_proposals VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET entry_json=excluded.entry_json WHERE chatkit_campaign_proposals.entry_json=? AND json_extract(chatkit_campaign_proposals.entry_json,'$.batchDigest')=json_extract(excluded.entry_json,'$.batchDigest')",
      )
      .run(this.key(entry.scope, entry.proposalId), JSON.stringify(entry), expectedJson);
    const actual = this.load(entry.scope, entry.proposalId);
    if (!actual) throw new Error("Campaign proposal disappeared.");
    return { won: result.changes === 1, entry: actual };
  }
  private view(entry: Entry): AiDmJsonValue {
    return {
      ...entry,
      ...entry.scope,
      requiresConfirmation: true,
      reviewAvailable: true,
      trust: "untrusted-source-data",
    };
  }
  private storage(identity: AiDmAuthenticatedIdentity, signal: AbortSignal): CampaignStorage {
    const expires = this.now() + 10_000;
    return new CampaignStorage(this.options.worldsRoot, {
      authorize: (worldId) => {
        signal.throwIfAborted();
        if (!identity.isGm || worldId !== identity.worldId || this.now() >= expires)
          throw new Error("Campaign authorization lease expired.");
      },
      ...(this.options.assertPrivateStorage
        ? { assertPrivateStorage: this.options.assertPrivateStorage }
        : {}),
    }, 128_000, 512_000, this.options.protectedCampaign);
  }
  private checkScope(identity: AiDmAuthenticatedIdentity, scope: Scope): void {
    id.parse(scope.threadId);
    if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId)
      throw new Error("Campaign scope mismatch.");
  }
  private read(storage: CampaignStorage, worldId: string, path: string) {
    try {
      return storage.read(worldId, path);
    } catch (error) {
      if (error instanceof Error && error.message === "Campaign path does not exist.") return null;
      throw error;
    }
  }
  private receipt(entry: Entry, value: CampaignCommitReceipt): void {
    if (value.transactionId !== entry.transactionId || value.batchDigest !== entry.batchDigest)
      throw new Error("Campaign receipt conflict.");
    entry.status = "completed";
    entry.issue = null;
    entry.receipt = {
      receiptId: value.transactionId,
      proposalId: entry.proposalId,
      batchDigest: value.batchDigest,
      outcome: "completed",
      worldId: value.worldId,
      files: value.files.map((file) => ({ ...file, sourceHash: file.revision })),
      verifiedAt: this.now(),
    };
  }
  private reconcile(entry: Entry, storage: CampaignStorage): void {
    if (!["drafting", "dispatching", "uncertain"].includes(entry.status)) return;
    const expectedJson = JSON.stringify(entry);
    try {
      const draft = entry.approval === null;
      const receipt = storage.receipt(
        entry.scope.worldId,
        `${entry.transactionId}${draft ? "-draft" : ""}`,
      );
      storage.recover(entry.scope.worldId);
      if (receipt && draft) {
        if (receipt.batchDigest !== hashText(`${entry.batchDigest}:draft`))
          throw new Error("Draft receipt mismatch.");
        entry.status = "pending";
        entry.issue = null;
      } else if (receipt) this.receipt(entry, receipt);
      else {
        entry.status = "uncertain";
        entry.issue =
          "Interrupted commit rolled back or outcome unavailable; inspect before proposing again.";
      }
    } catch (error) {
      // A live writer owns its filesystem lock; observing it cannot steal its SQL state.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      entry.status = "uncertain";
      entry.issue = "Recovery requires authorized inspection; no automatic redispatch.";
    }
    Object.assign(entry, this.save(entry, expectedJson).entry);
  }
  private consistency(files: FileReview[], storage: CampaignStorage, worldId: string): void {
    const overview = files.find((file) => file.path === "overview.md");
    const index = files.find((file) => file.path === "index.md");
    if (!overview || !index)
      throw new Error("Review overview.md and index.md together with every campaign change.");
    const ids = new Set<string>();
    for (const file of files) {
      const meta = metadata(file.proposedText);
      if (
        file.path === "overview.md" &&
        meta["visibility"] === "public" &&
        /^#{1,6}\s+(GM-ONLY|DISCOVERABLE|OBSERVABLE)\b/im.test(file.proposedText)
      )
        throw new Error("Public overview cannot include private sections.");
      if (meta["canon_status"] !== "canon")
        throw new Error("Canonical targets require canon metadata; stored drafts remain separate.");
      if (ids.has(meta["id"]!)) throw new Error("Duplicate campaign resource IDs.");
      ids.add(meta["id"]!);
      if (file.beforeText !== null) {
        const previous = metadata(file.beforeText);
        if (previous["id"] !== meta["id"] || previous["revision"] === meta["revision"])
          throw new Error("Preserve stable IDs and advance metadata revisions.");
      }
    }
    const references = [...index.proposedText.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(
      (match) => match[1]!,
    );
    const oldReferences = [...(index.beforeText ?? "").matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(
      (match) => match[1]!,
    );
    for (const path of oldReferences)
      if (!references.includes(path))
        throw new Error(
          "Resource deletion/unindexing is not supported; preserve existing index references.",
        );
    for (const path of new Set(references)) {
      resourcePath(path);
      const proposed = files.find((file) => file.path === path);
      const text = proposed?.proposedText ?? this.read(storage, worldId, path)?.text;
      if (!text || metadata(text)["canon_status"] !== "canon")
        throw new Error("Index reference must resolve to a canonical resource.");
      if (!proposed) {
        const resourceId = metadata(text)["id"]!;
        if (ids.has(resourceId)) throw new Error("Duplicate campaign resource IDs.");
        ids.add(resourceId);
      }
    }
    for (const file of files.filter((file) => !["overview.md", "index.md"].includes(file.path)))
      if (!references.includes(file.path))
        throw new Error("Every proposed resource must be linked from index.md.");
  }
  async request(
    identity: AiDmAuthenticatedIdentity,
    scope: Scope,
    operation: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    this.checkScope(identity, scope);
    signal.throwIfAborted();
    await this.authorize(identity, signal);
    signal.throwIfAborted();
    const storage = this.storage(identity, signal);
    if (operation === "campaign_read") {
      const input = z
        .object({
          path: z.string().max(200),
          startLine: z.number().int().min(1).default(1),
          endLine: z.number().int().min(1).default(80),
        })
        .strict()
        .parse(args);
      resourcePath(input.path);
      if (input.endLine < input.startLine || input.endLine - input.startLine >= 80)
        throw new Error("Campaign read span exceeds budget.");
      const file = this.read(storage, scope.worldId, input.path);
      await this.authorize(identity, signal);
      signal.throwIfAborted();
      if (!file) return { status: "missing", path: input.path };
      const lines = file.text.split(/\r?\n/);
      let text = lines.slice(input.startLine - 1, input.endLine).join("\n");
      const truncated = Buffer.byteLength(text) > 8000 || input.endLine < lines.length;
      while (Buffer.byteLength(text) > 8000) text = text.slice(0, -1);
      return {
        status: "available",
        path: input.path,
        text,
        revision: file.revision,
        sourceHash: file.revision,
        span: { startLine: input.startLine, endLine: Math.min(input.endLine, lines.length) },
        truncated,
        trust: "untrusted-source-data",
      };
    }
    if (operation === "campaign_proposals") {
      const input = z.object({ proposalId: id.optional() }).strict().parse(args);
      if (input.proposalId) {
        const entry = this.load(scope, input.proposalId);
        if (!entry) throw new Error("Campaign proposal unavailable.");
        this.reconcile(entry, storage);
        await this.authorize(identity, signal);
        signal.throwIfAborted();
        return this.view(entry);
      }
      const prefix = this.key(scope, "").slice(0, -3);
      return this.db
        .prepare(
          "SELECT entry_json FROM chatkit_campaign_proposals WHERE scope_key>=? AND scope_key<? ORDER BY rowid DESC LIMIT 12",
        )
        .all(prefix, prefix + "\uffff")
        .map((row) => JSON.parse(String(row["entry_json"])) as Entry)
        .filter((entry) => this.key(entry.scope, "") === this.key(scope, ""))
        .slice(0, 12)
        .map((entry) => ({
          kind: "campaign",
          proposalId: entry.proposalId,
          title: entry.title,
          status: entry.status,
          batchDigest: entry.batchDigest,
          reviewAvailable: false,
          requiresConfirmation: true,
          receipt: entry.receipt,
        }));
    }
    if (operation !== "campaign_propose") throw new Error("Campaign operation denied.");
    if (!this.options.assertPrivateStorage)
      return {
        status: "storage_unavailable",
        reason:
          "Private campaign serving has not been verified; draft and canon persistence remain disabled.",
      };
    const input = proposalInput.parse(args);
    if (
      Buffer.byteLength(JSON.stringify(input)) > 16_000 ||
      new Set(input.files.map((file) => file.path.toLowerCase())).size !== input.files.length
    )
      throw new Error("Proposal too large or duplicate paths; split the proposal.");
    const existing = this.load(scope, input.proposalId);
    if (existing) {
      if (
        existing.title !== input.title ||
        stableJson(
          existing.files.map((file) => ({
            path: file.path,
            expectedRevision: file.expectedRevision,
            proposedText: file.proposedText,
          })),
        ) !== stableJson(input.files)
      )
        throw new Error("Proposal ID conflict.");
      this.reconcile(existing, storage);
      await this.authorize(identity, signal);
      signal.throwIfAborted();
      return this.view(existing);
    }
    if (
      Number(
        this.db.prepare("SELECT count(*) AS count FROM chatkit_campaign_proposals").get()!["count"],
      ) >= 5000
    )
      throw new Error("Campaign proposal retention budget reached; operator archival required.");
    const files = input.files.map((file) => {
      resourcePath(file.path);
      const before = this.read(storage, scope.worldId, file.path);
      if ((before?.revision ?? null) !== file.expectedRevision)
        throw new Error("Campaign revision conflict.");
      const after = metadata(file.proposedText);
      return {
        ...file,
        beforeHash: before?.revision ?? null,
        afterHash: hashText(file.proposedText),
        beforeText: before?.text ?? null,
        beforeCanonStatus: before ? (metadata(before.text)["canon_status"] ?? null) : null,
        afterCanonStatus: after["canon_status"]!,
      };
    });
    this.consistency(files, storage, scope.worldId);
    const entry: Entry = {
      kind: "campaign",
      schemaVersion: 1,
      proposalId: input.proposalId,
      title: input.title,
      scope,
      batchDigest: hashText(stableJson({ schemaVersion: 1, scope, title: input.title, files })),
      expiresAt: this.now() + 86_400_000,
      status: "pending",
      files,
      transactionId: `campaign-${randomUUID()}`,
      receipt: null,
      issue: null,
      approval: null,
    };
    if (Buffer.byteLength(JSON.stringify(this.view(entry))) > 24_000)
      throw new Error("Exact review exceeds transport budget; split the proposal.");
    await this.authorize(identity, signal);
    signal.throwIfAborted();
    const concurrent = this.load(scope, input.proposalId);
    if (concurrent) {
      if (concurrent.batchDigest !== entry.batchDigest)
        throw new Error("Concurrent campaign proposal conflict.");
      return this.view(concurrent);
    }
    // Privacy gate covers both SQLite proposal text and its separate draft files.
    this.options.assertPrivateStorage(scope.worldId);
    entry.status = "drafting";
    const claim = this.save(entry, null);
    if (!claim.won) {
      if (claim.entry.batchDigest !== entry.batchDigest)
        throw new Error("Concurrent campaign proposal conflict.");
      return this.view(claim.entry);
    }
    const draftingJson = JSON.stringify(entry);
    try {
      this.storage(identity, signal).commit(
        scope.worldId,
        files.map((file, i) => ({
          path: `drafts/${entry.transactionId}/${i}.md`,
          expectedRevision: null,
          text: file.proposedText.replace(/^(canon_status:\s*)canon\s*$/m, "$1draft"),
        })),
        {
          transactionId: `${entry.transactionId}-draft`,
          batchDigest: hashText(`${entry.batchDigest}:draft`),
        },
      );
      entry.status = "pending";
    } catch (error) {
      entry.status = "uncertain";
      entry.issue = error instanceof Error ? error.message : "Draft persistence unresolved.";
    }
    Object.assign(entry, this.save(entry, draftingJson).entry);
    await this.authorize(identity, signal);
    signal.throwIfAborted();
    return this.view(entry);
  }
  async browser(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    signal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    const input = z
      .object({
        kind: z.literal("campaign"),
        threadId: id,
        proposalId: id.optional(),
        batchDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        decision: z.enum(["approve", "reject", "cancel"]).optional(),
      })
      .strict()
      .parse(body);
    const scope = { worldId: identity.worldId, userId: identity.userId, threadId: input.threadId };
    this.checkScope(identity, scope);
    await this.authorize(identity, signal);
    signal.throwIfAborted();
    if (!input.decision)
      return this.request(
        identity,
        scope,
        "campaign_proposals",
        input.proposalId ? { proposalId: input.proposalId } : {},
        signal,
      );
    if (!input.proposalId || !input.batchDigest)
      throw new Error("Exact campaign decision requires proposal ID and digest.");
    const entry = this.load(scope, input.proposalId);
    if (!entry || entry.batchDigest !== input.batchDigest)
      throw new Error("Campaign proposal unavailable or digest mismatch.");
    const storage = this.storage(identity, signal);
    this.reconcile(entry, storage);
    if (entry.status !== "pending") return this.view(entry);
    const pendingJson = JSON.stringify(entry);
    if (input.decision !== "approve") {
      entry.status = input.decision === "reject" ? "rejected" : "cancelled";
      return this.view(this.save(entry, pendingJson).entry);
    }
    if (this.now() >= entry.expiresAt) {
      entry.status = "stale";
      entry.issue = "Proposal expired; review a new proposal.";
      return this.view(this.save(entry, pendingJson).entry);
    }
    this.consistency(entry.files, storage, scope.worldId);
    for (const file of entry.files)
      if (
        (this.read(storage, scope.worldId, file.path)?.revision ?? null) !== file.expectedRevision
      ) {
        entry.status = "stale";
        entry.issue = "Campaign changed after review.";
        return this.view(this.save(entry, pendingJson).entry);
      }
    await this.authorize(identity, signal);
    signal.throwIfAborted();
    // Synchronous claim+file dispatch has no await boundary. Other instances' SQLite claims lose.
    entry.status = "dispatching";
    entry.approval = {
      userId: identity.userId,
      batchDigest: entry.batchDigest,
      approvedAt: this.now(),
    };
    const dispatchClaim = this.save(entry, pendingJson);
    if (!dispatchClaim.won) return this.view(dispatchClaim.entry);
    const dispatchingJson = JSON.stringify(entry);
    try {
      const receipt = this.storage(identity, signal).commit(
        scope.worldId,
        entry.files.map((file) => ({
          path: file.path,
          expectedRevision: file.expectedRevision,
          text: file.proposedText,
        })),
        { transactionId: entry.transactionId, batchDigest: entry.batchDigest },
      );
      this.receipt(entry, receipt);
    } catch (error) {
      entry.status = "uncertain";
      entry.issue =
        error instanceof Error
          ? error.message
          : "Campaign commit unresolved; inspect before retrying.";
    }
    Object.assign(entry, this.save(entry, dispatchingJson).entry);
    await this.authorize(identity, signal);
    signal.throwIfAborted();
    return this.view(entry);
  }
}
