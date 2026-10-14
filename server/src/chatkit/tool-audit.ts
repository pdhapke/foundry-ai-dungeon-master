import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface ChatKitToolAuditEvent {
  worldId: string;
  userId: string;
  threadId: string;
  runCorrelation: string;
  operation: string;
  arguments: unknown;
  result?: unknown;
  outcome: "attempt" | "returned" | "error" | "cancelled";
}
export type ChatKitToolAuditObserver = (event: ChatKitToolAuditEvent) => void;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const digest = (v: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(v) ?? "null")
    .digest("hex");
const credentialShape = /(?:sk-|eyJ)[A-Za-z0-9_.-]+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)[=:._-]/i;
const id = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9_:./-]{1,160}$/.test(v) && !credentialShape.test(v)
    ? v
    : undefined;
const statuses = new Set([
  "completed",
  "pending",
  "uncertain",
  "stale",
  "cancelled",
  "rejected",
  "failed",
  "dispatching",
]);

/** Durable evidence only; never grants permission or affects execution/retries. */
export class ChatKitToolAudit {
  constructor(
    readonly db: DatabaseSync,
    readonly retention = 2000,
  ) {
    if (!Number.isInteger(retention) || retention < 1 || retention > 100_000)
      throw new Error("Invalid audit retention");
    db.exec(
      "CREATE TABLE IF NOT EXISTS chatkit_tool_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,world TEXT NOT NULL,owner TEXT NOT NULL,thread TEXT NOT NULL,run TEXT NOT NULL,record_json TEXT NOT NULL)",
    );
  }
  readonly observe: ChatKitToolAuditObserver = (event) => {
    if (!["tool_search", "tool_load", "tool_execute"].includes(event.operation)) return;
    const input = obj(event.arguments),
      envelope = obj(event.result),
      value = obj(envelope["value"]);
    const denial = obj(envelope["denial"]);
    const grantDigest = typeof input["grantId"] === "string" ? digest(input["grantId"]) : undefined;
    let selectedTool = id(input["toolId"]);
    let loadedSchemaDigest: unknown;
    if (grantDigest) {
      const rows = this.db
        .prepare(
          "SELECT record_json FROM chatkit_tool_audit WHERE world=? AND owner=? AND thread=? AND run=? ORDER BY sequence DESC LIMIT 100",
        )
        .all(event.worldId, event.userId, event.threadId, event.runCorrelation);
      for (const row of rows) {
        const previous = obj(JSON.parse(String(row["record_json"])));
        if (previous["grantDigest"] === grantDigest && previous["operation"] === "tool_load") {
          selectedTool = id(previous["toolId"]);
          loadedSchemaDigest = previous["schemaDigest"];
          break;
        }
      }
    }
    const definition = obj(value["definition"]),
      grant = obj(value["grant"]);
    const result = obj(value["result"]);
    const semantic = Object.keys(result).length ? result : value;
    const status = statuses.has(String(semantic["status"])) ? semantic["status"] : undefined;
    const record: Record<string, unknown> = {
      occurredAt: new Date().toISOString(),
      operation: event.operation,
      outcome:
        event.outcome === "returned"
          ? envelope["ok"] === false
            ? "denied"
            : status === "uncertain"
              ? "uncertain"
              : "returned"
          : event.outcome,
      argumentsDigest: digest(event.arguments),
      toolId: selectedTool ?? id(definition["toolId"]),
      denialCode:
        typeof denial["code"] === "string" && /^TOOL_[A-Z_]{1,64}$/.test(denial["code"])
          ? denial["code"]
          : undefined,
      effect: ["read", "present", "propose", "session"].includes(String(input["effect"]))
        ? input["effect"]
        : undefined,
      grantDigest:
        grantDigest ??
        (typeof grant["grantId"] === "string" ? digest(grant["grantId"]) : undefined),
      schemaDigest:
        typeof definition["schemaDigest"] === "string" &&
        /^[a-f0-9]{64}$/.test(definition["schemaDigest"])
          ? definition["schemaDigest"]
          : typeof loadedSchemaDigest === "string" && /^[a-f0-9]{64}$/.test(loadedSchemaDigest)
            ? loadedSchemaDigest
            : undefined,
      actionId: id(obj(input["arguments"])["actionId"]),
      status,
    };
    if (event.operation === "tool_search") {
      // Search is discovery data, but redact credential-shaped text and URLs.
      record["query"] =
        typeof input["query"] === "string"
          ? input["query"]
              .slice(0, 256)
              .replace(
                /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)|https?:\/\/\S+|(?:bearer\s+\S+)|\b(?:sk-|eyJ)[A-Za-z0-9_.-]+|\b[A-Za-z0-9_-]{32,}\b/gi,
                "[redacted]",
              )
          : undefined;
      record["returnedToolIds"] = Array.isArray(value["descriptors"])
        ? value["descriptors"]
            .slice(0, 8)
            .map((v) => id(obj(v)["toolId"]))
            .filter(Boolean)
        : [];
    }
    if (typeof semantic["paused"] === "boolean") record["paused"] = semantic["paused"];
    const receipt = obj(semantic["receipt"]),
      readback = obj(receipt["readBack"]);
    if (typeof readback["paused"] === "boolean") record["readBackPaused"] = readback["paused"];
    if (
      receipt["verifiedBy"] === "foundry_get_game_paused" &&
      typeof receipt["paused"] === "boolean"
    )
      record["readBackPaused"] = receipt["paused"];
    this.db
      .prepare(
        "INSERT INTO chatkit_tool_audit(world,owner,thread,run,record_json) VALUES(?,?,?,?,?)",
      )
      .run(
        event.worldId,
        event.userId,
        event.threadId,
        event.runCorrelation,
        JSON.stringify(record),
      );
    this.db
      .prepare(
        "DELETE FROM chatkit_tool_audit WHERE sequence NOT IN (SELECT sequence FROM chatkit_tool_audit ORDER BY sequence DESC LIMIT ?)",
      )
      .run(this.retention);
  };
  /** Caller supplies authenticated scope; no HTTP route or credentials exposed. */
  list(
    scope: { worldId: string; userId: string; threadId: string },
    after = 0,
    limit = 50,
  ): unknown[] {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid audit page");
    return this.db
      .prepare(
        "SELECT sequence,record_json FROM chatkit_tool_audit WHERE world=? AND owner=? AND thread=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(scope.worldId, scope.userId, scope.threadId, after, limit)
      .map((r) => ({ sequence: r["sequence"], ...obj(JSON.parse(String(r["record_json"]))) }));
  }
}
