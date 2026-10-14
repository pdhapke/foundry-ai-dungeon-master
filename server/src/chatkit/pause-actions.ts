import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { validateArguments, type FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { bounded } from "./bounded-call.js";
import type { SessionRequestAuthorization } from "./pause-request.js";
const inputSchema = z
  .object({
    actionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    paused: z.boolean(),
    expectedPaused: z.boolean(),
  })
  .strict();
type Scope = { worldId: string; userId: string; threadId: string };
function createPauseRequestId(scope: Scope, actionId: string): string {
  return createHash("sha256").update(JSON.stringify([scope, actionId])).digest("hex");
}
type Entry = {
  scope: Scope;
  input: z.infer<typeof inputSchema>;
  kind: "pause";
  status: "dispatching" | "completed" | "stale" | "cancelled" | "uncertain";
  correlationId: string;
  receipt: AiDmJsonValue | null;
};
/** Explicit current-user intent plus live GM scope; no model argument can supply that authorization. */
export class ChatKitPauseActions {
  /** Fixed reviewed pause contract: no model discovery or independent state read. */
  async setConfirmed(identity: AiDmAuthenticatedIdentity, scope: Scope, args: unknown,
    requestedPaused: boolean | undefined, signal: AbortSignal, authority?: SessionRequestAuthorization): Promise<AiDmJsonValue> {
    const input = z.object({ actionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), paused: z.boolean() }).strict().parse(args);
    if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId || !scope.threadId ||
      (requestedPaused === undefined ? !authority?.worldControl?.manualRequest || !/^[a-f0-9]{64}$/.test(authority.worldControl.requestDigest) : requestedPaused !== input.paused))
      throw new Error("Current authenticated GM manual pause request required");
    signal.throwIfAborted();
    await bounded(this.authorize(identity, signal), signal);
    const key = this.key(scope, `core-${input.actionId}`);
    const existing = this.db.prepare("SELECT entry_json FROM chatkit_pause_actions WHERE scope_key=?").get(key);
    if (existing) {
      const prior = JSON.parse(String(existing["entry_json"])) as Record<string, AiDmJsonValue>;
      if (prior["paused"] !== input.paused) throw new Error("Pause action ID argument conflict");
      return prior["result"] ?? { outcome: "uncertain", correlationId: prior["correlationId"] ?? null, worldId: scope.worldId, paused: null, mutated: false };
    }
    const correlationId = `aidm-${randomUUID()}`;
    const pending = { scope, kind: "pause", actionId: input.actionId, paused: input.paused, correlationId };
    this.db.prepare("INSERT INTO chatkit_pause_actions VALUES (?,?)").run(key, JSON.stringify(pending));
    let result: AiDmJsonValue;
    const started = performance.now();
    try {
      const receipt = await bounded(this.client.callTool({ name: "foundry_set_game_paused_confirmed",
        arguments: { paused: input.paused, worldId: scope.worldId, userId: scope.userId,
          requestId: createPauseRequestId(scope, input.actionId), correlationId, origin: "ai-dm" }, idempotencyKey: null },
        { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }), signal);
      await bounded(this.authorize(identity, signal), signal);
      const value = receipt as Record<string, AiDmJsonValue>;
      if (!value || typeof value !== "object" || Array.isArray(value) || value["worldId"] !== scope.worldId ||
        value["correlationId"] !== correlationId || typeof value["outcome"] !== "string" || !["confirmed", "uncertain", "failure"].includes(value["outcome"]) ||
        (value["outcome"] === "confirmed" && value["paused"] !== input.paused)) throw new Error("Invalid authoritative pause receipt");
      result = receipt;
    } catch {
      // Durable uncertain receipt prevents a retry from blindly repeating a possible mutation.
      result = { outcome: "uncertain", paused: null, worldId: scope.worldId, correlationId, mutated: false,
        message: "Pause acknowledgement unavailable; inspect current state before a new request." };
    }
    console.info(JSON.stringify({ type: "pause-timing", stage: "mcp-execution-and-ack", correlationId, durationMs: performance.now() - started, result }));
    this.db.prepare("UPDATE chatkit_pause_actions SET entry_json=? WHERE scope_key=?").run(JSON.stringify({ ...pending, result }), key);
    return result;
  }
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
      "CREATE TABLE IF NOT EXISTS chatkit_pause_actions (scope_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)",
    );
  }
  private key(scope: Scope, actionId: string) {
    return JSON.stringify([scope.worldId, scope.userId, scope.threadId, actionId]);
  }
  private view(entry: Entry): AiDmJsonValue {
    return { ...entry, actionId: entry.input.actionId, requiresConfirmation: false };
  }
  async read(
    identity: AiDmAuthenticatedIdentity,
    scope: Scope,
    outerSignal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId)
      throw new Error("Current GM world required");
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    signal.throwIfAborted();
    await bounded(this.authorize(identity, signal), signal);
    const definitions = await bounded(this.client.listTools(), signal);
    const schema = definitions.find((tool) => tool.name === "foundry_get_game_paused")?.inputSchema;
    if (!schema || validateArguments(schema, {}).length)
      throw new Error("Pause read schema unavailable");
    const state = await bounded(
      this.client.callTool(
        { name: "foundry_get_game_paused", arguments: {}, idempotencyKey: null },
        { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
      ),
      signal,
    );
    await bounded(this.authorize(identity, signal), signal);
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      typeof state["paused"] !== "boolean"
    )
      throw new Error("Malformed pause read-back");
    return { paused: state["paused"], worldId: scope.worldId, trust: "untrusted-source-data" };
  }
  recent(scope: Scope): AiDmJsonValue[] {
    return this.db
      .prepare("SELECT entry_json FROM chatkit_pause_actions ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(String(row["entry_json"])) as Entry)
      .filter((entry) => Boolean(entry.scope))
      .filter((entry) => JSON.stringify(entry.scope) === JSON.stringify(scope))
      .slice(0, 12)
      .map((entry) => entry.input ? this.view(entry) : { ...entry, input: { paused: (entry as unknown as Record<string, AiDmJsonValue>)["paused"] ?? false }, status: ((entry as unknown as Record<string, AiDmJsonValue>)["result"] as Record<string, AiDmJsonValue> | undefined)?.["outcome"] ?? "uncertain", receipt: (entry as unknown as Record<string, AiDmJsonValue>)["result"] ?? null } as unknown as AiDmJsonValue);
  }
  async request(
    identity: AiDmAuthenticatedIdentity,
    scope: Scope,
    args: unknown,
    requestedPaused: boolean | undefined,
    outerSignal: AbortSignal,
    authority?: SessionRequestAuthorization,
  ): Promise<AiDmJsonValue> {
    const input = inputSchema.parse(args);
    if (
      !identity.isGm ||
      identity.worldId !== scope.worldId ||
      identity.userId !== scope.userId ||
      !scope.threadId ||
      (requestedPaused === undefined
        ? !authority?.worldControl?.manualRequest ||
          !/^[a-f0-9]{64}$/.test(authority.worldControl.requestDigest)
        : requestedPaused !== input.paused)
    )
      throw new Error("Explicit current GM pause request required");
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    const check = async () => {
      signal.throwIfAborted();
      await bounded(this.authorize(identity, signal), signal);
      signal.throwIfAborted();
    };
    await check();
    const key = this.key(scope, input.actionId);
    const load = () => {
      const row = this.db
        .prepare("SELECT entry_json FROM chatkit_pause_actions WHERE scope_key=?")
        .get(key);
      return row ? (JSON.parse(String(row["entry_json"])) as Entry) : undefined;
    };
    const previous = load();
    if (previous) {
      if (JSON.stringify(previous.input) !== JSON.stringify(input))
        throw new Error("Pause action ID argument conflict");
      return this.view(
        previous.status === "dispatching" ? { ...previous, status: "uncertain" } : previous,
      );
    }
    const definitions = await bounded(this.client.listTools(), signal);
    const call = async (name: string, argumentsValue: AiDmJsonValue) => {
      await check();
      const schema = definitions.find((tool) => tool.name === name)?.inputSchema;
      if (!schema || validateArguments(schema, argumentsValue).length)
        throw new Error("Pause capability schema unavailable");
      return bounded(
        this.client.callTool(
          { name, arguments: argumentsValue, idempotencyKey: null },
          { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
        ),
        signal,
      );
    };
    const read = async () => {
      const state = await call("foundry_get_game_paused", {});
      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        typeof state["paused"] !== "boolean"
      )
        throw new Error("Malformed pause read-back");
      return state["paused"];
    };
    const before = await read();
    const entry: Entry = {
      scope,
      input,
      kind: "pause",
      status: "dispatching",
      correlationId: `aidm-${randomUUID()}`,
      receipt: null,
    };
    if (before !== input.expectedPaused && before !== input.paused) entry.status = "stale";
    await check();
    // INSERT-only durable claim prevents duplicate dispatch across processes. No unconditional overwrite.
    const claim = this.db
      .prepare("INSERT INTO chatkit_pause_actions VALUES (?,?) ON CONFLICT(scope_key) DO NOTHING")
      .run(key, JSON.stringify(entry));
    if (!claim.changes) {
      const winner = load()!;
      if (JSON.stringify(winner.input) !== JSON.stringify(input))
        throw new Error("Pause action ID argument conflict");
      return this.view(
        winner.status === "dispatching" ? { ...winner, status: "uncertain" } : winner,
      );
    }
    if (entry.status === "stale") return this.view(entry);
    const claimedJson = JSON.stringify(entry);
    let dispatched = false;
    try {
      if (before !== input.paused) {
        if ((await read()) !== before) throw new Error("Pause state changed before dispatch");
        const current = await bounded(this.client.listTools(), signal);
        if (JSON.stringify(current) !== JSON.stringify(definitions))
          throw new Error("Pause schema drift before dispatch");
        // Validation/authorization are repeated immediately before marking dispatch; never treat a possible mutation as retryable.
        await check();
        const setterSchema = definitions.find(
          (tool) => tool.name === "foundry_set_game_paused",
        )?.inputSchema;
        if (!setterSchema || validateArguments(setterSchema, { paused: input.paused }).length)
          throw new Error("Pause setter schema unavailable");
        dispatched = true;
        await call("foundry_set_game_paused", { paused: input.paused });
      }
      const after = await read();
      await check();
      if (after !== input.paused) throw new Error("Pause read-back did not match requested state");
      entry.status = "completed";
      entry.receipt = {
        outcome: "completed",
        worldId: scope.worldId,
        correlationId: entry.correlationId,
        before,
        paused: after,
        mutated: before !== after,
        verifiedBy: "foundry_get_game_paused",
      };
    } catch {
      entry.status = dispatched ? "uncertain" : signal.aborted ? "cancelled" : "stale";
    }
    this.db
      .prepare("UPDATE chatkit_pause_actions SET entry_json=? WHERE scope_key=? AND entry_json=?")
      .run(JSON.stringify(entry), key, claimedJson);
    return this.view(load()!);
  }
}

