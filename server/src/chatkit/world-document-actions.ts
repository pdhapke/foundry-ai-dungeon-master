import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { validateArguments, type FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { hashText, stableJson } from "../context/hash.js";
import { bounded } from "./bounded-call.js";
import {
  REVIEWED_WORLD_TOOLS,
  sensitiveDocumentChange,
  type WorldToolPolicy,
} from "./world-tool-policy.js";
import type { SessionRequestAuthorization } from "./pause-request.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const argsSchema = z
  .object({
    toolId: id,
    args: z.record(z.string(), z.unknown()),
    actionId: id.optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    offset: z.number().int().min(0).max(100000).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();
type Scope = { worldId: string; userId: string; threadId: string };
type Entry = {
  kind: "world";
  scope: Scope;
  actionId: string;
  toolId: string;
  schemaDigest: string;
  request: AiDmJsonValue;
  before: AiDmJsonValue;
  reviewDigest: string;
  correlationId: string;
  status:
    "pending" | "dispatching" | "completed" | "rejected" | "cancelled" | "stale" | "uncertain";
  receipt: AiDmJsonValue | null;
  requestDigest: string;
};
function object(value: unknown): Record<string, AiDmJsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid world document data");
  return value as Record<string, AiDmJsonValue>;
}
export function worldSourceRevision(value: unknown): string | null {
  if (value === null) return null;
  return hashText(worldCanonicalJson(value, true));
}
export function worldCanonicalJson(value: unknown, omitStats = false): string {
  const clean = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(clean)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([key, child]) => (!omitStats || key !== "_stats") && child !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, clean(child)]),
          )
        : v;
  return JSON.stringify(clean(value));
}
function assertSafeKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)) ||
      key.startsWith("$")
    )
      throw new Error("Unsafe document key");
    assertSafeKeys(child);
  }
}
function rejectExecutableData(value: unknown): void {
  if (
    typeof value === "string" &&
    /<script\b|\bon\w+\s*=|javascript:|^macro[.]|^(?:executeScript|executeMacro)$/i.test(
      value.trim(),
    )
  )
    throw new Error("Executable content requires separate code executor");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:^|[.])(?:_stats|_source|pack|parent|command|script|macro|dae|itemacro|onUpdateTarget|onUpdateSource|onUseMacroName|onUseMacroParts)(?:[.]|$)|(?:^|[.])-=/.test(
        key,
      )
    )
      throw new Error("Unsupported document data key");
    rejectExecutableData(child);
  }
}
function sanitize(value: AiDmJsonValue): AiDmJsonValue {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key|password)$/i.test(
              key,
            ),
        )
        .map(([key, child]) => [key, sanitize(child)]),
    );
  return value;
}
function requestedFieldsMatch(
  data: Record<string, AiDmJsonValue>,
  source: Record<string, AiDmJsonValue>,
): boolean {
  return Object.entries(data).every(([key, value]) => {
    let found: AiDmJsonValue | undefined = source;
    for (const part of key.split(".")) {
      if (!found || typeof found !== "object" || Array.isArray(found)) return false;
      found = found[part];
    }
    if (value && typeof value === "object" && !Array.isArray(value))
      return (
        !!found &&
        typeof found === "object" &&
        !Array.isArray(found) &&
        requestedFieldsMatch(value, found)
      );
    return stableJson(found) === stableJson(value);
  });
}
/** Full active-world document access, separate from the deliberately small narration snapshot. */
export class ChatKitWorldDocumentActions {
  constructor(
    private readonly client: FoundryLocalApiMcpClient,
    private readonly db: DatabaseSync,
    private readonly authorize: (
      identity: AiDmAuthenticatedIdentity,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly timeoutMs = 10000,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS chatkit_world_document_actions(scope_key TEXT PRIMARY KEY,entry_json TEXT NOT NULL)",
    );
  }
  private key(scope: Scope, actionId: string) {
    return JSON.stringify([scope.worldId, scope.userId, scope.threadId, actionId]);
  }
  private load(scope: Scope, actionId: string): Entry | undefined {
    const row = this.db
      .prepare("SELECT entry_json FROM chatkit_world_document_actions WHERE scope_key=?")
      .get(this.key(scope, actionId));
    return row ? (JSON.parse(String(row["entry_json"])) as Entry) : undefined;
  }
  private view(entry: Entry, exactBrowserReview = false): AiDmJsonValue {
    const before = object(entry.before);
    const receipt = entry.receipt ? object(entry.receipt) : null;
    const compactReceipt = receipt
      ? Object.fromEntries(
          Object.entries(receipt).filter(([key]) =>
            [
              "worldId",
              "family",
              "operation",
              "targetId",
              "parentId",
              "revision",
              "correlationId",
              "idempotencyKey",
              "verified",
              "verifiedBy",
              "outcome",
            ].includes(key),
          ),
        )
      : null;
    return {
      ...entry,
      before: exactBrowserReview
        ? entry.before
        : {
            targetId: before["targetId"]!,
            revision: before["revision"]!,
            ...(before["parentId"] ? { parentId: before["parentId"] } : {}),
          },
      request: exactBrowserReview
        ? entry.request
        : { exactBrowserReviewRequired: entry.status === "pending" },
      receipt: exactBrowserReview ? entry.receipt : compactReceipt,
      status: entry.status === "dispatching" ? "uncertain" : entry.status,
      requiresConfirmation: entry.status === "pending",
      reviewComplete: exactBrowserReview,
      trust: "untrusted-source-data",
      narrationAllowed: false,
    };
  }
  recent(scope: Scope): AiDmJsonValue[] {
    const prefix = JSON.stringify([scope.worldId, scope.userId, scope.threadId]).slice(0, -1) + ",";
    return this.db
      .prepare(
        "SELECT entry_json FROM chatkit_world_document_actions WHERE scope_key>=? AND scope_key<? ORDER BY rowid DESC LIMIT 12",
      )
      .all(prefix, prefix + "\uffff")
      .map((row) => JSON.parse(String(row["entry_json"])) as Entry)
      .filter((entry) => stableJson(entry.scope) === stableJson(scope))
      .map((entry) => this.view(entry));
  }
  private async context(
    identity: AiDmAuthenticatedIdentity,
    scope: Scope,
    outerSignal: AbortSignal,
  ) {
    if (!identity.isGm || scope.worldId !== identity.worldId || scope.userId !== identity.userId)
      throw new Error("Live GM world scope required");
    id.parse(scope.threadId);
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    const check = async () => {
      signal.throwIfAborted();
      await bounded(this.authorize(identity, signal), signal);
      signal.throwIfAborted();
    };
    await check();
    const definitions = await bounded(this.client.listTools(), signal);
    const call = async (name: string, args: AiDmJsonValue) => {
      await check();
      const schema = definitions.find((tool) => tool.name === name)?.inputSchema;
      if (!schema || validateArguments(schema, args).length)
        throw new Error("World capability schema unavailable");
      const result = await bounded(
        this.client.callTool(
          { name, arguments: args, idempotencyKey: null },
          { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
        ),
        signal,
      );
      if (Buffer.byteLength(JSON.stringify(result)) > 30000)
        throw new Error("World result budget exceeded");
      await check();
      return object(result);
    };
    return { signal, check, definitions, call };
  }
  async request(
    identity: AiDmAuthenticatedIdentity,
    scope: Scope,
    operation: "read" | "write" | "authorize",
    raw: unknown,
    authority: SessionRequestAuthorization | undefined,
    outerSignal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    if (Buffer.byteLength(JSON.stringify(raw)) > 16000)
      throw new Error("World argument budget exceeded");
    const input = argsSchema.parse(raw);
    assertSafeKeys(input.args);
    const policy = REVIEWED_WORLD_TOOLS.get(input.toolId);
    if (!policy) throw new Error("World tool not reviewed");
    const readOnly = policy.operation === "get" || policy.operation === "list";
    if ((operation === "read") !== readOnly && operation !== "authorize")
      throw new Error("World effect mismatch");
    if (
      !readOnly &&
      (!authority?.worldControl?.manualRequest ||
        !/^[a-f0-9]{64}$/.test(authority.worldControl.requestDigest))
    )
      throw new Error("Current ordinary GM request required");
    const ctx = await this.context(identity, scope, outerSignal);
    const advertised = ctx.definitions.find((tool) => tool.name === input.toolId);
    if (!advertised || validateArguments(advertised.inputSchema, object(input.args)).length)
      throw new Error("Selected world schema mismatch");
    const parentId = policy.family.parentKey
      ? id.parse(input.args[policy.family.parentKey])
      : undefined;
    const targetId =
      policy.operation === "create"
        ? undefined
        : policy.operation === "list"
          ? undefined
          : id.parse(input.args[policy.family.idKey]);
    const base = {
      worldId: scope.worldId,
      requestingUserId: scope.userId,
      family: policy.family.family,
      ...(parentId ? { parentId } : {}),
    };
    if (readOnly) {
      const result = await ctx.call("foundry_get_world_document", {
        ...base,
        operation: policy.operation,
        ...(targetId ? { targetId } : {}),
        ...(policy.operation === "list"
          ? { offset: input.offset ?? 0, limit: input.limit ?? 8 }
          : {}),
      });
      if (
        result["worldId"] !== scope.worldId ||
        result["family"] !== policy.family.family ||
        result["operation"] !== policy.operation ||
        result["parentId"] !== parentId
      )
        throw new Error("World read scope mismatch");
      if (
        policy.operation === "get" &&
        (result["targetId"] !== targetId ||
          result["parentId"] !== parentId ||
          worldSourceRevision(result["source"]) !== result["revision"])
      )
        throw new Error("World source hash mismatch");
      return {
        ...(sanitize(result) as Record<string, AiDmJsonValue>),
        narrationAllowed: false,
        trust: "untrusted-source-data",
      };
    }
    if (operation === "authorize") {
      await ctx.check();
      return { authorized: true };
    }
    if (!input.actionId || input.expectedRevision === undefined)
      throw new Error("Durable action ID and expected revision required");
    const existing = this.load(scope, input.actionId);
    if (existing) {
      if (stableJson(existing.request) !== stableJson(input))
        throw new Error("World action ID conflict");
      return this.view(existing);
    }
    const selectedTarget = targetId ?? randomBytes(8).toString("hex");
    const before = await ctx.call("foundry_get_world_document", {
      ...base,
      operation: "get",
      targetId: selectedTarget,
    });
    this.checkSource(before, scope, policy, selectedTarget, parentId);
    if (before["revision"] !== input.expectedRevision)
      throw new Error("World document revision stale");
    const data =
      policy.operation === "create"
        ? object(input.args["data"])
        : policy.operation === "update"
          ? object(input.args["changes"])
          : undefined;
    rejectExecutableData(data);
    if (data && "_id" in data) throw new Error("Server-owned document ID required");
    const destructive = policy.destructive || sensitiveDocumentChange(data);
    const entry: Entry = {
      kind: "world",
      scope,
      actionId: input.actionId,
      toolId: input.toolId,
      schemaDigest: hashText(stableJson(advertised.inputSchema)),
      request: input as AiDmJsonValue,
      before,
      reviewDigest: hashText(worldCanonicalJson({ scope, input, before, selectedTarget })),
      correlationId: `aidm-${randomUUID()}`,
      status: destructive ? "pending" : "dispatching",
      receipt: null,
      requestDigest: authority!.worldControl!.requestDigest,
    };
    // Server-selected create ID is frozen in review/dispatch state, never chosen by a model.
    entry.before = { ...before, targetId: selectedTarget };
    const claim = this.db
      .prepare(
        "INSERT INTO chatkit_world_document_actions VALUES (?,?) ON CONFLICT(scope_key) DO NOTHING",
      )
      .run(this.key(scope, entry.actionId), JSON.stringify(entry));
    if (!claim.changes) {
      const winner = this.load(scope, entry.actionId)!;
      if (stableJson(winner.request) !== stableJson(input))
        throw new Error("World action ID conflict");
      return this.view(winner);
    }
    if (destructive) return this.view(entry);
    return this.execute(identity, entry, false, ctx.signal);
  }
  private checkSource(
    result: Record<string, AiDmJsonValue>,
    scope: Scope,
    policy: WorldToolPolicy,
    targetId: string,
    parentId?: string,
  ) {
    if (
      result["worldId"] !== scope.worldId ||
      result["family"] !== policy.family.family ||
      result["targetId"] !== targetId ||
      result["parentId"] !== parentId ||
      worldSourceRevision(result["source"]) !== result["revision"]
    )
      throw new Error("World read-back scope/hash mismatch");
  }
  private async execute(
    identity: AiDmAuthenticatedIdentity,
    entry: Entry,
    reviewedDestructive: boolean,
    outerSignal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    const original = JSON.stringify(entry);
    const policy = REVIEWED_WORLD_TOOLS.get(entry.toolId)!;
    const input = argsSchema.parse(entry.request);
    const targetId = id.parse(object(entry.before)["targetId"]);
    let dispatched = false;
    try {
      const ctx = await this.context(identity, entry.scope, outerSignal);
      if (
        hashText(
          stableJson(ctx.definitions.find((tool) => tool.name === entry.toolId)?.inputSchema),
        ) !== entry.schemaDigest
      )
        throw new Error("World tool schema changed after proposal");
      const base = {
        worldId: entry.scope.worldId,
        requestingUserId: entry.scope.userId,
        family: policy.family.family,
        targetId,
        ...(policy.family.parentKey
          ? { parentId: id.parse(input.args[policy.family.parentKey]) }
          : {}),
      };
      const before = await ctx.call("foundry_get_world_document", { ...base, operation: "get" });
      this.checkSource(
        before,
        entry.scope,
        policy,
        targetId,
        "parentId" in base ? base.parentId : undefined,
      );
      if (before["revision"] !== input.expectedRevision)
        throw new Error("World document changed after review");
      const payload = {
        ...base,
        operation: policy.operation,
        ...(policy.operation !== "delete"
          ? { data: object(input.args[policy.operation === "update" ? "changes" : "data"]) }
          : {}),
        expectedRevision: input.expectedRevision!,
        correlationId: entry.correlationId,
        idempotencyKey: entry.correlationId,
        reviewedDestructive,
      };
      const schema = ctx.definitions.find(
        (tool) => tool.name === "foundry_apply_world_document",
      )?.inputSchema;
      if (!schema || validateArguments(schema, payload).length)
        throw new Error("World mutation schema unavailable");
      await ctx.check();
      dispatched = true;
      const result = await ctx.call("foundry_apply_world_document", payload);
      if (
        result["verified"] !== true ||
        result["correlationId"] !== entry.correlationId ||
        result["idempotencyKey"] !== entry.correlationId ||
        result["operation"] !== policy.operation
      )
        throw new Error("World execution receipt mismatch");
      this.checkSource(
        result,
        entry.scope,
        policy,
        targetId,
        "parentId" in base ? base.parentId : undefined,
      );
      const after = await ctx.call("foundry_get_world_document", { ...base, operation: "get" });
      this.checkSource(
        after,
        entry.scope,
        policy,
        targetId,
        "parentId" in base ? base.parentId : undefined,
      );
      if (
        after["revision"] !== result["revision"] ||
        stableJson(after["source"]) !== stableJson(result["source"])
      )
        throw new Error("World independent read-back mismatch");
      if (
        policy.operation === "delete"
          ? after["source"] !== null
          : !requestedFieldsMatch(object(payload.data), object(after["source"]))
      )
        throw new Error("World requested result mismatch");
      await ctx.check();
      entry.status = "completed";
      entry.receipt = {
        ...(sanitize(result) as Record<string, AiDmJsonValue>),
        verifiedBy: "foundry_get_world_document",
        outcome: "completed",
      };
    } catch {
      entry.status = dispatched ? "uncertain" : outerSignal.aborted ? "cancelled" : "stale";
    }
    this.db
      .prepare(
        "UPDATE chatkit_world_document_actions SET entry_json=? WHERE scope_key=? AND entry_json=?",
      )
      .run(JSON.stringify(entry), this.key(entry.scope, entry.actionId), original);
    return this.view(this.load(entry.scope, entry.actionId)!);
  }
  async browser(
    identity: AiDmAuthenticatedIdentity,
    raw: unknown,
    outerSignal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    const input = z
      .object({
        kind: z.literal("world"),
        threadId: id,
        actionId: id.optional(),
        reviewDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        decision: z.enum(["approve", "reject", "cancel"]).optional(),
      })
      .strict()
      .parse(raw);
    const scope = { worldId: identity.worldId, userId: identity.userId, threadId: input.threadId };
    const ctx = await this.context(identity, scope, outerSignal);
    if (!input.actionId) {
      if (input.decision || input.reviewDigest)
        throw new Error("World decision requires action ID");
      return this.recent(scope).map((value) => {
        const entry = object(value);
        return {
          kind: "world",
          scope: entry["scope"]!,
          actionId: entry["actionId"]!,
          toolId: entry["toolId"]!,
          reviewDigest: entry["reviewDigest"]!,
          status: entry["status"]!,
          requiresConfirmation: entry["requiresConfirmation"]!,
          reviewAvailable: true,
        };
      });
    }
    const entry = this.load(scope, input.actionId);
    if (!entry) throw new Error("World proposal unavailable");
    if (!input.decision || entry.status !== "pending") return this.view(entry, true);
    if (input.reviewDigest !== entry.reviewDigest)
      throw new Error("Exact world review digest required");
    const original = JSON.stringify(entry);
    entry.status =
      input.decision === "approve"
        ? "dispatching"
        : input.decision === "reject"
          ? "rejected"
          : "cancelled";
    const claim = this.db
      .prepare(
        "UPDATE chatkit_world_document_actions SET entry_json=? WHERE scope_key=? AND entry_json=?",
      )
      .run(JSON.stringify(entry), this.key(scope, entry.actionId), original);
    if (!claim.changes) return this.view(this.load(scope, entry.actionId)!, true);
    if (input.decision !== "approve") return this.view(entry, true);
    return this.execute(identity, entry, true, ctx.signal);
  }
}
