import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { validateArguments, type FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { bounded } from "./bounded-call.js";
import { stableJson } from "../context/hash.js";
import { ChatKitAttackSequences, attackSequenceSchema } from "./attack-sequences.js";
import { ChatKitAttackActions, attackActionSchema } from "./attack-actions.js";
import { ChatKitCoreActions } from "./core-actions.js";
import { ChatKitPauseActions } from "./pause-actions.js";
import { ChatKitSessionActions } from "./session-actions.js";
import type { SessionRequestAuthorization } from "./pause-request.js";
import { ChatKitWorldDocumentActions } from "./world-document-actions.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const roll = z
  .object({
    actionId: id,
    formula: z.string().regex(/^([1-9]|[1-9][0-9])d(4|6|8|10|12|20|100)([+-][0-9]{1,3})?$/),
  })
  .strict();
const note = z
  .object({
    actionId: id,
    title: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(4000),
  })
  .strict();
const decision = z
  .object({ threadId: id, actionId: id, decision: z.enum(["approve", "reject"]) })
  .strict();
type Scope = { worldId: string; userId: string; threadId: string };
type Entry = {
  scope: Scope;
  actionId: string;
  kind: "roll" | "note";
  input: AiDmJsonValue;
  sceneId: string;
  status: "pending" | "dispatching" | "completed" | "rejected" | "uncertain";
  expires: number;
  receipt: AiDmJsonValue | null;
  manifest: AiDmJsonValue | null;
};
const obj = (value: AiDmJsonValue): Record<string, AiDmJsonValue> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed native result");
  return value;
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** Parse only bounded integer sums/differences and parentheses; never evaluate code. */
function resolvedTerms(expression: string): number[] {
  if (expression.length > 2048) throw new Error("Roll expression too large");
  const text = expression.replace(/\s/g, "");
  let cursor = 0;
  const operand = (depth: number): number[] => {
    if (depth > 8) throw new Error("Roll expression too deep");
    if (text[cursor] === "(") {
      cursor++;
      const terms = sum(depth + 1);
      if (text[cursor++] !== ")") throw new Error("Malformed roll expression");
      return terms;
    }
    const match = /^[0-9]{1,5}/.exec(text.slice(cursor));
    if (!match) throw new Error("Non-numeric roll expression");
    cursor += match[0].length;
    return [Number(match[0])];
  };
  const sum = (depth: number): number[] => {
    const terms = operand(depth);
    while (text[cursor] === "+" || text[cursor] === "-") {
      const sign = text[cursor++] === "-" ? -1 : 1;
      terms.push(...operand(depth).map((value) => sign * value));
      if (terms.length > 100) throw new Error("Roll expression exceeds dice budget");
    }
    return terms;
  };
  const terms = sum(0);
  if (cursor !== text.length) throw new Error("Unexpected roll expression token");
  return terms;
}

/** Reviewed native subset. Durable dispatch claim precedes every effect; uncertain effects never redispatch. */
export class ChatKitNativeActions {
  private readonly core: ChatKitCoreActions;
  private readonly attacks: ChatKitAttackActions;
  private readonly sequences: ChatKitAttackSequences;
  private readonly pauses: ChatKitPauseActions;
  private readonly sessions: ChatKitSessionActions;
  private readonly worlds: ChatKitWorldDocumentActions;
  constructor(
    private readonly client: FoundryLocalApiMcpClient,
    private readonly db: DatabaseSync,
    private readonly authorize: (
      identity: AiDmAuthenticatedIdentity,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly timeoutMs = 10_000,
    private readonly now = Date.now,
  ) {
    this.core = new ChatKitCoreActions(client, db, authorize, timeoutMs);
    this.attacks = new ChatKitAttackActions(client, db, authorize, timeoutMs);
    this.sequences = new ChatKitAttackSequences(client, db, authorize);
    this.pauses = new ChatKitPauseActions(client, db, authorize, timeoutMs);
    this.sessions = new ChatKitSessionActions(client, db, authorize, timeoutMs);
    this.worlds = new ChatKitWorldDocumentActions(client, db, authorize, timeoutMs);
    db.exec(
      "CREATE TABLE IF NOT EXISTS chatkit_native_actions (scope_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)",
    );
    // A crash between dispatch and receipt is unresolved, never an invitation to retry.
    for (const row of db
      .prepare("SELECT scope_key, entry_json FROM chatkit_native_actions")
      .all()) {
      const entry = JSON.parse(String(row["entry_json"])) as Entry;
      if (entry.status === "dispatching") {
        entry.status = "uncertain";
        this.save(entry);
      }
    }
  }
  private key(scope: Scope, actionId: string): string {
    return JSON.stringify([scope.worldId, scope.userId, scope.threadId, actionId]);
  }
  private load(scope: Scope, actionId: string): Entry | undefined {
    const row = this.db
      .prepare("SELECT entry_json FROM chatkit_native_actions WHERE scope_key=?")
      .get(this.key(scope, actionId));
    return row ? (JSON.parse(String(row["entry_json"])) as Entry) : undefined;
  }
  private save(entry: Entry): void {
    this.db
      .prepare(
        "INSERT INTO chatkit_native_actions VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET entry_json=excluded.entry_json",
      )
      .run(this.key(entry.scope, entry.actionId), JSON.stringify(entry));
  }
  private view(entry: Entry): AiDmJsonValue {
    return {
      actionId: entry.actionId,
      kind: entry.kind,
      input: entry.input,
      sceneId: entry.sceneId,
      status: entry.status,
      expires: entry.expires,
      receipt: entry.receipt,
      transactionId: entry.manifest ? obj(entry.manifest)["correlationId"]! : null,
      requiresConfirmation: entry.kind === "note",
      policy:
        "Dice are automatic and never posted to chat. Session journals are GM-private and require explicit confirmation. HP, doors, inventory and arbitrary mutations are unavailable. Uncertain outcomes require inspection; never retry under a new action ID.",
    };
  }
  recent(scope: Scope): AiDmJsonValue {
    const prefix = JSON.stringify([scope.worldId, scope.userId, scope.threadId]).slice(0, -1) + ",";
    const entries = this.db
      .prepare(
        "SELECT entry_json FROM chatkit_native_actions WHERE scope_key>=? AND scope_key<? ORDER BY rowid DESC LIMIT 12",
      )
      .all(prefix, prefix + "\uffff")
      .map((row) => JSON.parse(String(row["entry_json"])) as Entry)
      .filter(
        (entry) =>
          entry.scope.worldId === scope.worldId &&
          entry.scope.userId === scope.userId &&
          entry.scope.threadId === scope.threadId,
      )
      .map((entry) => this.view(entry));
    return [
      ...this.worlds.recent(scope),
      ...this.sessions.recent(scope),
      ...this.pauses.recent(scope),
      ...this.core.recent(scope),
      ...entries,
    ].slice(0, 12);
  }
  private async call(
    tool: string,
    args: AiDmJsonValue,
    signal: AbortSignal,
    identity?: AiDmAuthenticatedIdentity,
  ): Promise<AiDmJsonValue> {
    signal.throwIfAborted();
    const definition = (await bounded(this.client.listTools(), signal)).find(
      (candidate) => candidate.name === tool,
    );
    if (!definition || validateArguments(definition.inputSchema, args).length)
      throw new Error("Native capability unavailable or schema mismatch");
    if (identity) await bounded(this.authorize(identity, signal), signal);
    return bounded(
      this.client.callTool(
        { name: tool, arguments: args, idempotencyKey: null },
        { signal, timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
      ),
      signal,
    );
  }
  private async scene(identity: AiDmAuthenticatedIdentity, signal: AbortSignal): Promise<string> {
    if (!identity.isGm) throw new Error("GM required");
    await bounded(this.authorize(identity, signal), signal);
    const scenes = await this.call("foundry_list_scenes", {}, signal);
    if (!Array.isArray(scenes)) throw new Error("Malformed scenes");
    const active = scenes.map(obj).find((scene) => scene["active"] === true);
    return id.parse(active?.["_id"] ?? active?.["id"]);
  }
  async request(
    identity: AiDmAuthenticatedIdentity,
    scope: Scope,
    operation: string,
    args: unknown,
    outerSignal: AbortSignal,
    requestedPaused?: boolean,
    sessionAuthorization?: SessionRequestAuthorization,
  ): Promise<AiDmJsonValue> {
    if (["native_world_read", "native_world_write", "native_world_authorize"].includes(operation))
      return this.worlds.request(
        identity,
        scope,
        operation === "native_world_read"
          ? "read"
          : operation === "native_world_authorize"
            ? "authorize"
            : "write",
        args,
        sessionAuthorization,
        outerSignal,
      );
    if (operation === "native_authorize_pause") {
      const input = z
        .object({ actionId: id, paused: z.boolean(), expectedPaused: z.boolean() })
        .strict()
        .parse(args);
      if (
        !identity.isGm ||
        scope.worldId !== identity.worldId ||
        scope.userId !== identity.userId ||
        (requestedPaused === undefined
          ? !sessionAuthorization?.worldControl?.manualRequest ||
            !/^[a-f0-9]{64}$/.test(sessionAuthorization.worldControl.requestDigest)
          : requestedPaused !== input.paused)
      )
        throw new Error("Direct GM pause request required");
      await this.authorize(identity, outerSignal);
      outerSignal.throwIfAborted();
      return { authorized: true };
    }
    if (operation.startsWith("native_session_"))
      return this.sessions.request(
        identity,
        scope,
        operation,
        args,
        sessionAuthorization,
        outerSignal,
      );
    if (operation === "native_attack_sequence")
      return this.sequences.request(identity, scope, args, sessionAuthorization, outerSignal);
    if (operation === "native_attack_state")
      return this.attacks.read(identity, scope, args, outerSignal);
    if (operation === "native_attack_action")
      return this.attacks.request(identity, scope, args, sessionAuthorization, outerSignal);
    if (operation === "native_core_action")
      return this.core.request(identity, scope, args, sessionAuthorization, outerSignal);
    if (operation === "native_core_move_batch")
      return this.core.moveBatch(identity, scope, args, sessionAuthorization, outerSignal);
    if (operation === "native_core_state")
      return this.core.read(identity, scope, args, outerSignal);
    if (operation === "native_token_light_read")
      return this.core.readTokenLight(identity, scope, args, outerSignal);
    if (operation === "native_set_pause_core")
      return this.pauses.setConfirmed(
        identity,
        scope,
        args,
        requestedPaused,
        outerSignal,
        sessionAuthorization,
      );
    if (operation === "native_get_pause") return this.pauses.read(identity, scope, outerSignal);
    if (operation === "native_set_pause")
      return this.pauses.request(
        identity,
        scope,
        args,
        requestedPaused,
        outerSignal,
        sessionAuthorization,
      );
    if (scope.worldId !== identity.worldId || scope.userId !== identity.userId)
      throw new Error("Action scope mismatch");
    id.parse(scope.threadId);
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    const input =
      operation === "native_roll"
        ? roll.parse(args)
        : operation === "native_propose_note"
          ? note.parse(args)
          : (() => {
              throw new Error("Action denied");
            })();
    const sceneId = await this.scene(identity, signal);
    const existing = this.load(scope, input.actionId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input))
        throw new Error("Action ID reused with different arguments");
      return this.view(existing);
    }
    const entry: Entry = {
      scope,
      actionId: input.actionId,
      input,
      kind: operation === "native_roll" ? "roll" : "note",
      sceneId,
      status: "pending",
      expires: this.now() + 300_000,
      receipt: null,
      manifest: null,
    };
    if (entry.kind === "note") {
      const value = note.parse(input);
      const transactionId = `aidm-${randomUUID()}`;
      entry.manifest = {
        mode: "atomic",
        rollbackPolicy: "strict",
        worldId: scope.worldId,
        correlationId: transactionId,
        idempotencyKey: transactionId,
        operations: [
          {
            operationId: "session-note",
            kind: "document.create",
            documentType: "JournalEntry",
            data: {
              _id: randomBytes(8).toString("hex"),
              name: value.title,
              ownership: { default: 0 },
              pages: [
                {
                  name: "Session note",
                  type: "text",
                  text: {
                    content: `<p>${escape(value.text).replaceAll("\n", "</p><p>")}</p>`,
                    format: 1,
                  },
                },
              ],
            },
          },
        ],
      };
      const checked = obj(await this.call("foundry_preflight_transaction", entry.manifest, signal));
      if (checked["valid"] !== true || checked["transactionId"] !== transactionId)
        throw new Error("Native preflight failed");
      // Another concurrent request may have won during preflight.
      const concurrent = this.load(scope, input.actionId);
      if (concurrent) {
        if (JSON.stringify(concurrent.input) !== JSON.stringify(input))
          throw new Error("Action ID conflict");
        return this.view(concurrent);
      }
      this.save(entry);
      return this.view(entry);
    }
    // No await between absence check and durable insertion/claim.
    this.save(entry);
    return this.dispatch(entry, identity, signal);
  }
  async browser(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    outerSignal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    const sequenceList = z
      .object({ kind: z.literal("attack-sequence"), threadId: id })
      .strict()
      .safeParse(body);
    if (sequenceList.success) {
      if (!identity.isGm) throw Error("GM required");
      await bounded(this.authorize(identity, outerSignal), outerSignal);
      outerSignal.throwIfAborted();
      return this.sequences.recent({
        worldId: identity.worldId,
        userId: identity.userId,
        threadId: sequenceList.data.threadId,
      });
    }
    const sequenceAction = z
      .object({
        kind: z.literal("attack-sequence"),
        threadId: id,
        actionId: id,
        action: attackSequenceSchema,
      })
      .strict()
      .safeParse(body);
    if (sequenceAction.success)
      return this.sequences.request(
        identity,
        {
          worldId: identity.worldId,
          userId: identity.userId,
          threadId: sequenceAction.data.threadId,
        },
        { actionId: sequenceAction.data.actionId, action: sequenceAction.data.action },
        {
          worldControl: {
            manualRequest: true,
            requestDigest: createHash("sha256")
              .update(stableJson(sequenceAction.data))
              .digest("hex"),
          },
        },
        outerSignal,
      );
    const attackList = z
      .object({ kind: z.literal("attack"), threadId: id })
      .strict()
      .safeParse(body);
    if (attackList.success) {
      if (!identity.isGm) throw new Error("GM required");
      await bounded(this.authorize(identity, outerSignal), outerSignal);
      outerSignal.throwIfAborted();
      return this.attacks.recent({
        worldId: identity.worldId,
        userId: identity.userId,
        threadId: attackList.data.threadId,
      });
    }
    const directAttack = z
      .object({ kind: z.literal("attack"), threadId: id, actionId: id, action: attackActionSchema })
      .strict()
      .safeParse(body);
    if (directAttack.success) {
      const action = directAttack.data.action;
      return this.attacks.request(
        identity,
        {
          worldId: identity.worldId,
          userId: identity.userId,
          threadId: directAttack.data.threadId,
        },
        { actionId: directAttack.data.actionId, action },
        {
          worldControl: {
            manualRequest: true,
            requestDigest: createHash("sha256")
              .update(JSON.stringify(directAttack.data))
              .digest("hex"),
          },
          ...(action.mode === "apply" && action.decisionId
            ? {
                attackDecision: {
                  priorAttackRequestId: action.priorAttackRequestId,
                  decisionId: action.decisionId,
                },
              }
            : {}),
        },
        outerSignal,
      );
    }
    const directBatch = z
      .object({
        kind: z.literal("core-move-batch"),
        threadId: id,
        actionId: id,
        sceneId: id,
        moves: z.unknown(),
      })
      .strict()
      .safeParse(body);
    if (directBatch.success)
      return this.core.moveBatch(
        identity,
        { worldId: identity.worldId, userId: identity.userId, threadId: directBatch.data.threadId },
        {
          actionId: directBatch.data.actionId,
          sceneId: directBatch.data.sceneId,
          moves: directBatch.data.moves,
        },
        {
          worldControl: {
            manualRequest: true,
            requestDigest: createHash("sha256")
              .update(JSON.stringify(directBatch.data))
              .digest("hex"),
          },
        },
        outerSignal,
      );
    const directCore = z
      .object({ kind: z.literal("core"), threadId: id, actionId: id, action: z.unknown() })
      .strict()
      .safeParse(body);
    if (directCore.success)
      return this.core.request(
        identity,
        { worldId: identity.worldId, userId: identity.userId, threadId: directCore.data.threadId },
        { actionId: directCore.data.actionId, action: directCore.data.action },
        {
          worldControl: {
            manualRequest: true,
            requestDigest: createHash("sha256")
              .update(JSON.stringify(directCore.data))
              .digest("hex"),
          },
        },
        outerSignal,
      );
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>)["kind"] === "world"
    )
      return this.worlds.browser(identity, body, outerSignal);
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(this.timeoutMs)]);
    const list = z.object({ threadId: id }).strict().safeParse(body);
    if (list.success) {
      await this.scene(identity, signal);
      return this.recent({
        worldId: identity.worldId,
        userId: identity.userId,
        threadId: list.data.threadId,
      });
    }
    const input = decision.parse(body);
    let entry = this.load(
      { worldId: identity.worldId, userId: identity.userId, threadId: input.threadId },
      input.actionId,
    );
    if (!entry || entry.kind !== "note") throw new Error("Proposal unavailable");
    await this.scene(identity, signal);
    entry = this.load(
      { worldId: identity.worldId, userId: identity.userId, threadId: input.threadId },
      input.actionId,
    )!;
    if (entry.status !== "pending") return this.view(entry);
    if (input.decision === "reject") {
      entry.status = "rejected";
      this.save(entry);
      return this.view(entry);
    }
    return this.dispatch(entry, identity, signal);
  }
  private async dispatch(
    entry: Entry,
    identity: AiDmAuthenticatedIdentity,
    signal: AbortSignal,
  ): Promise<AiDmJsonValue> {
    const sceneId = await this.scene(identity, signal);
    if (sceneId !== entry.sceneId || this.now() >= entry.expires)
      throw new Error("Stale or expired action");
    if (entry.manifest) {
      const preflight = obj(
        await this.call("foundry_preflight_transaction", entry.manifest, signal),
      );
      if (
        preflight["valid"] !== true ||
        preflight["transactionId"] !== obj(entry.manifest)["correlationId"]
      )
        throw new Error("Stale preflight");
      if ((await this.scene(identity, signal)) !== entry.sceneId) throw new Error("Scene changed");
    }
    const current = this.load(entry.scope, entry.actionId);
    if (!current || current.status !== "pending")
      return current
        ? this.view(current)
        : (() => {
            throw new Error("Action disappeared");
          })();
    signal.throwIfAborted();
    entry.status = "dispatching";
    this.save(entry);
    try {
      const result = await this.call(
        entry.kind === "roll" ? "foundry_roll_dice" : "foundry_execute_transaction",
        entry.manifest ?? { formula: roll.parse(entry.input).formula },
        signal,
        identity,
      );
      const receipt = obj(result);
      if (entry.kind === "roll") {
        const requested = roll.parse(entry.input).formula;
        const match = /^([0-9]+)d([0-9]+)([+-][0-9]+)?$/.exec(requested)!;
        const count = Number(match[1]);
        const faces = Number(match[2]);
        const modifier = Number(match[3] ?? 0);
        if (
          typeof receipt["total"] !== "number" ||
          !Number.isFinite(receipt["total"]) ||
          typeof receipt["formula"] !== "string" ||
          typeof receipt["result"] !== "string" ||
          !Array.isArray(receipt["dice"]) ||
          receipt["formula"].replace(/\s/g, "") !== requested ||
          receipt["dice"].length !== 1
        )
          throw new Error("Incomplete roll receipt");
        // Native local-api returns one term with numeric evaluated results, not raw Roll objects.
        // Our formula subset has no rerolls/keep/drop/explode modifiers; every die must contribute.
        const die = obj(receipt["dice"][0]!);
        if (
          die["faces"] !== faces ||
          !Array.isArray(die["results"]) ||
          die["results"].length !== count ||
          die["results"].some(
            (value) =>
              typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > faces,
          )
        )
          throw new Error("Mismatched native dice");
        const diceTotal = (die["results"] as number[]).reduce((sum, value) => sum + value, 0);
        if (receipt["total"] !== diceTotal + modifier) throw new Error("Mismatched roll total");
        const terms = resolvedTerms(receipt["result"]);
        const suffix = match[3] === undefined ? [] : [modifier];
        const expectedExpressions = [
          [diceTotal, ...suffix],
          [...(die["results"] as number[]), ...suffix],
          [diceTotal + modifier],
        ];
        if (
          !expectedExpressions.some(
            (expected) => JSON.stringify(expected) === JSON.stringify(terms),
          )
        )
          throw new Error("Mismatched resolved roll expression");
      } else {
        const expected = obj((obj(entry.manifest)["operations"] as AiDmJsonValue[])[0]!);
        if (
          receipt["committed"] !== true ||
          receipt["transactionId"] !== obj(entry.manifest)["correlationId"] ||
          receipt["idempotencyKey"] !== obj(entry.manifest)["idempotencyKey"] ||
          !Array.isArray(receipt["operations"]) ||
          receipt["operations"].length !== 1
        )
          throw new Error("Incomplete mutation receipt");
        const actual = obj(receipt["operations"][0]!);
        if (
          actual["operationId"] !== "session-note" ||
          actual["documentType"] !== "JournalEntry" ||
          actual["kind"] !== "document.create" ||
          actual["documentId"] !== obj(expected["data"]!)["_id"] ||
          typeof actual["revision"] !== "string" ||
          !/^[a-f0-9]{64}$/.test(actual["revision"])
        )
          throw new Error("Mismatched mutation receipt");
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 16_000) throw new Error("Receipt too large");
      entry.receipt = result;
      entry.status = "completed";
    } catch {
      entry.status = "uncertain";
    }
    this.save(entry);
    return this.view(entry);
  }
}
