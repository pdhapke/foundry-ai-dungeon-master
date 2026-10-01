import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  AI_DM_PROTOCOL_VERSION,
  aiDmIdSchema,
  aiDmIsoTimestampSchema,
  type AiDmAccessScope,
  type AiDmActionProposal,
  type AiDmApprovalDecision,
  type AiDmContextReceipt,
  type AiDmContinuationCapsule,
  type AiDmJsonValue,
  type AiDmLoadedToolDefinition,
  type AiDmMessage,
  type AiDmNormalizedEvent,
  type AiDmRun,
  type AiDmRunStatus,
  type AiDmServerDelivery,
  type AiDmServerPayload,
  type AiDmSynchronizationResult,
  type AiDmThread,
  type AiDmToolEffect,
  type AiDmToolSearchResult,
} from "@foundry-ai-dungeon-master/shared";

import { AiDmStorageConflictError, AiDmStorageError } from "./errors.js";
import { parseStoredJson, prepareStoredJson } from "./json.js";

type SqlRow = Record<string, string | number | bigint | null>;

export type AppendNormalizedEventInput = Omit<
  AiDmNormalizedEvent,
  "sequence" | "payloadHash" | "receivedAt"
> & { receivedAt?: string };

export type AppendMessageInput = Omit<AiDmMessage, "threadSequence">;

export interface MessageRecipient {
  deliveryId: string;
  recipientUserId: string;
}

export type EnqueueDeliveryInput = Omit<AiDmServerDelivery, "recipientSequence">;

export interface HistoryRequest {
  threadId: string;
  worldId: string;
  requesterUserId: string;
  requesterIsGm: boolean;
  afterSequence?: number;
  limit: number;
}

export interface ThreadReadRequest {
  worldId: string;
  requesterUserId: string;
  requesterIsGm: boolean;
}

export interface HistoryPage {
  messages: AiDmMessage[];
  runs: Array<{ runId: string; status: AiDmRunStatus; failureCode: string | null }>;
  hasMore: boolean;
}

export interface ToolExecutionInput {
  executionId: string;
  runId: string;
  toolId: string;
  effect: AiDmToolEffect;
  idempotencyKey: string | null;
  arguments: AiDmJsonValue;
  createdAt: string;
}

export interface ToolExecutionRecord extends ToolExecutionInput {
  state: "pending" | "succeeded" | "failed" | "recovery-required";
  result: AiDmJsonValue | null;
  safeErrorCode: string | null;
  updatedAt: string;
}

export interface CommitReceiptInput {
  receiptId: string;
  proposalId: string;
  operationId: string;
  idempotencyKey: string;
  status: "verified" | "failed" | "recovery-required";
  result: AiDmJsonValue;
  createdAt: string;
}

export interface LeasedDelivery {
  delivery: AiDmServerDelivery;
  attempts: number;
  leaseOwner: string;
  leaseUntil: string;
}

export interface SynchronizationFailureInput {
  failureId: string;
  runId: string;
  proposalId: string | null;
  operationId: string;
  safeErrorCode: string;
  details: AiDmJsonValue;
  occurredAt: string;
}

export interface RecoverySummary {
  failedRuns: number;
  uncertainCommits: number;
  recoveredOutboxRows: number;
  toolExecutionsNeedingReconciliation: number;
}

const RUN_TRANSITIONS: Readonly<Record<AiDmRunStatus, readonly AiDmRunStatus[]>> = {
  queued: ["projecting", "cancelled", "failed"],
  projecting: ["reading-context", "failed", "cancelled"],
  "reading-context": ["searching-tools", "resolving", "failed", "cancelled"],
  "searching-tools": ["reading-context", "resolving", "failed", "cancelled"],
  resolving: [
    "reading-context",
    "searching-tools",
    "waiting-for-player",
    "waiting-for-gm",
    "committing",
    "delivering",
    "failed",
    "cancelled",
  ],
  "waiting-for-player": ["resolving", "committing", "failed", "cancelled"],
  "waiting-for-gm": ["resolving", "committing", "failed", "cancelled"],
  committing: ["delivering", "failed"],
  delivering: ["complete", "failed"],
  complete: [],
  failed: [],
  cancelled: [],
};

function requireId(value: string, field: string): void {
  const result = aiDmIdSchema.safeParse(value);
  if (!result.success) {
    throw new AiDmStorageError("INVALID_STORAGE_INPUT", `${field} is invalid.`);
  }
}

function requireTimestamp(value: string, field: string): void {
  if (!aiDmIsoTimestampSchema.safeParse(value).success) {
    throw new AiDmStorageError("INVALID_STORAGE_INPUT", `${field} is not an ISO timestamp.`);
  }
}

function requireBoundedText(value: string, field: string, maximum = 512): void {
  if (!value || value.length > maximum) {
    throw new AiDmStorageError("INVALID_STORAGE_INPUT", `${field} is outside its allowed range.`);
  }
}

function requirePositiveInteger(
  value: number,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AiDmStorageError("INVALID_STORAGE_INPUT", `${field} is outside its allowed range.`);
  }
}

function rowText(row: SqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new AiDmStorageError("STORAGE_ROW_INVALID", `Stored ${field} is not text.`);
  }
  return value;
}

function rowNumber(row: SqlRow, field: string): number {
  const value = row[field];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new AiDmStorageError("STORAGE_ROW_INVALID", `Stored ${field} is not a safe integer.`);
  }
  return number;
}

function accessAllows(scope: AiDmAccessScope, userId: string, isGm: boolean): boolean {
  if (scope.kind === "public") return true;
  if (scope.kind === "gm") return isGm;
  return scope.userIds.includes(userId) || isGm;
}

export class AiDmOperationalStore {
  constructor(private readonly database: DatabaseSync) {}

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(input: AppendNormalizedEventInput): {
    event: AiDmNormalizedEvent;
    replayed: boolean;
  } {
    requireId(input.eventId, "eventId");
    requireId(input.authenticatedIdentity.clientId, "authenticatedIdentity.clientId");
    requireId(input.authenticatedIdentity.userId, "authenticatedIdentity.userId");
    requireId(input.authenticatedIdentity.worldId, "authenticatedIdentity.worldId");
    requireBoundedText(input.eventType, "eventType", 160);
    requireBoundedText(input.sourceCorrelationId, "sourceCorrelationId");
    requireBoundedText(input.deduplicationKey, "deduplicationKey");
    if (input.causeEventId) requireId(input.causeEventId, "causeEventId");
    requireTimestamp(input.occurredAt, "occurredAt");
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    requireTimestamp(receivedAt, "receivedAt");
    const payload = prepareStoredJson<AiDmJsonValue>(input.payload);
    const stableInput = prepareStoredJson({
      ...input,
      receivedAt: undefined,
      payloadHash: undefined,
    });

    return this.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT event_json, record_hash FROM normalized_events
           WHERE event_id = ? OR (world_id = ? AND deduplication_key = ?)
           ORDER BY sequence LIMIT 1`,
        )
        .get(input.eventId, input.authenticatedIdentity.worldId, input.deduplicationKey) as
        SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "record_hash") !== stableInput.digest) {
          throw new AiDmStorageConflictError("Event identity was reused with different content.", {
            eventId: input.eventId,
          });
        }
        return {
          event: parseStoredJson<AiDmNormalizedEvent>(rowText(existing, "event_json")),
          replayed: true,
        };
      }

      const inserted = this.database
        .prepare(
          `INSERT INTO normalized_events(
             event_id, world_id, event_type, source, occurred_at, received_at,
             authenticated_client_id, authenticated_user_id, deduplication_key,
             source_correlation_id, source_state_revision, cause_event_id, presentation,
             payload_hash, record_hash, event_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
        )
        .run(
          input.eventId,
          input.authenticatedIdentity.worldId,
          input.eventType,
          input.source,
          input.occurredAt,
          receivedAt,
          input.authenticatedIdentity.clientId,
          input.authenticatedIdentity.userId,
          input.deduplicationKey,
          input.sourceCorrelationId,
          input.sourceStateRevision,
          input.causeEventId ?? null,
          input.presentation,
          payload.digest,
          stableInput.digest,
        );
      const sequence = Number(inserted.lastInsertRowid);
      const event = prepareStoredJson<AiDmNormalizedEvent>({
        ...input,
        sequence,
        receivedAt,
        payload: payload.value,
        payloadHash: payload.digest,
      });
      this.database
        .prepare("UPDATE normalized_events SET event_json = ? WHERE sequence = ?")
        .run(event.text, sequence);
      return { event: event.value, replayed: false };
    });
  }

  getEvent(eventId: string): AiDmNormalizedEvent | null {
    requireId(eventId, "eventId");
    const row = this.database
      .prepare("SELECT event_json FROM normalized_events WHERE event_id = ?")
      .get(eventId) as SqlRow | undefined;
    return row ? parseStoredJson<AiDmNormalizedEvent>(rowText(row, "event_json")) : null;
  }

  getEventByDeduplicationKey(
    worldId: string,
    deduplicationKey: string,
    requesterUserId: string,
    requesterIsGm: boolean,
  ): AiDmNormalizedEvent | null {
    requireId(worldId, "worldId");
    requireId(requesterUserId, "requesterUserId");
    requireBoundedText(deduplicationKey, "deduplicationKey");
    const row = this.database
      .prepare(
        `SELECT authenticated_user_id, event_json FROM normalized_events
         WHERE world_id=? AND deduplication_key=?`,
      )
      .get(worldId, deduplicationKey) as SqlRow | undefined;
    if (!row || (!requesterIsGm && rowText(row, "authenticated_user_id") !== requesterUserId)) {
      return null;
    }
    return parseStoredJson<AiDmNormalizedEvent>(rowText(row, "event_json"));
  }

  recordProjection(
    projection: import("@foundry-ai-dungeon-master/shared").AiDmRuntimeProjection,
  ): void {
    requireId(projection.projectionId, "projectionId");
    const stored = prepareStoredJson(projection);
    this.transaction(() => {
      const event = this.database
        .prepare("SELECT world_id FROM normalized_events WHERE event_id=?")
        .get(projection.eventId) as SqlRow | undefined;
      if (!event) throw new AiDmStorageError("NOT_FOUND", "Projection event was not found.");
      if (rowText(event, "world_id") !== projection.worldId) {
        throw new AiDmStorageError(
          "PROJECTION_SCOPE_INVALID",
          "Projection world does not match its event.",
        );
      }
      const existing = this.database
        .prepare(
          "SELECT record_hash FROM runtime_projections WHERE projection_id = ? OR event_id = ?",
        )
        .get(projection.projectionId, projection.eventId) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "record_hash") !== stored.digest) {
          throw new AiDmStorageConflictError(
            "Projection identity was reused with different content.",
          );
        }
        return;
      }
      this.database
        .prepare(
          `INSERT INTO runtime_projections(
             projection_id, event_id, revision, captured_at, projection_json, record_hash
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projection.projectionId,
          projection.eventId,
          projection.revision,
          projection.capturedAt,
          stored.text,
          stored.digest,
        );
    });
  }

  createThread(thread: AiDmThread): { thread: AiDmThread; replayed: boolean } {
    requireId(thread.threadId, "threadId");
    requireId(thread.worldId, "worldId");
    requireId(thread.ownerUserId, "ownerUserId");
    requireTimestamp(thread.createdAt, "createdAt");
    requireTimestamp(thread.updatedAt, "updatedAt");
    if (thread.participantScope.kind === "users") {
      for (const userId of thread.participantScope.userIds) requireId(userId, "participantUserId");
    }
    const stored = prepareStoredJson<AiDmThread>(thread);
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT thread_json, create_hash FROM ai_dm_threads WHERE thread_id = ?")
        .get(thread.threadId) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "create_hash") !== stored.digest) {
          throw new AiDmStorageConflictError("Thread identity was reused with different content.");
        }
        return {
          thread: parseStoredJson<AiDmThread>(rowText(existing, "thread_json")),
          replayed: true,
        };
      }
      this.database
        .prepare(
          `INSERT INTO ai_dm_threads(
             thread_id, world_id, owner_user_id, status, revision, thread_json,
             create_hash, record_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          thread.threadId,
          thread.worldId,
          thread.ownerUserId,
          thread.status,
          thread.revision,
          stored.text,
          stored.digest,
          stored.digest,
          thread.createdAt,
          thread.updatedAt,
        );
      return { thread: stored.value, replayed: false };
    });
  }

  getThread(threadId: string, request: ThreadReadRequest): AiDmThread | null {
    requireId(threadId, "threadId");
    requireId(request.worldId, "worldId");
    requireId(request.requesterUserId, "requesterUserId");
    const row = this.database
      .prepare("SELECT world_id, thread_json FROM ai_dm_threads WHERE thread_id=?")
      .get(threadId) as SqlRow | undefined;
    if (!row || rowText(row, "world_id") !== request.worldId) return null;
    const thread = parseStoredJson<AiDmThread>(rowText(row, "thread_json"));
    return accessAllows(thread.participantScope, request.requesterUserId, request.requesterIsGm)
      ? thread
      : null;
  }

  resolveActiveThread(ownerUserId: string, request: ThreadReadRequest): AiDmThread | null {
    requireId(ownerUserId, "ownerUserId");
    requireId(request.worldId, "worldId");
    requireId(request.requesterUserId, "requesterUserId");
    const row = this.database
      .prepare(
        `SELECT thread_json FROM ai_dm_threads
         WHERE world_id=? AND owner_user_id=? AND status='active' LIMIT 1`,
      )
      .get(request.worldId, ownerUserId) as SqlRow | undefined;
    if (!row) return null;
    const thread = parseStoredJson<AiDmThread>(rowText(row, "thread_json"));
    return accessAllows(thread.participantScope, request.requesterUserId, request.requesterIsGm)
      ? thread
      : null;
  }

  createRun(run: AiDmRun): { run: AiDmRun; replayed: boolean } {
    requireId(run.runId, "runId");
    requireId(run.eventId, "eventId");
    requireId(run.threadId, "threadId");
    requireId(run.principal.userId, "principal.userId");
    requireId(run.principal.worldId, "principal.worldId");
    requirePositiveInteger(run.attempt, "attempt", 10_000);
    requireTimestamp(run.createdAt, "createdAt");
    requireTimestamp(run.updatedAt, "updatedAt");
    if (
      run.status !== "queued" ||
      run.statusRevision !== 0 ||
      run.providerResponseId !== null ||
      run.providerResponseRunBinding !== null
    ) {
      throw new AiDmStorageError(
        "PROVIDER_CHAIN_SCOPE_INVALID",
        "A fresh run must start queued without a provider response chain.",
      );
    }
    const stored = prepareStoredJson<AiDmRun>(run);
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT run_json, create_hash FROM ai_dm_runs WHERE run_id = ?")
        .get(run.runId) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "create_hash") !== stored.digest) {
          throw new AiDmStorageConflictError("Run identity was reused with different content.");
        }
        return { run: parseStoredJson<AiDmRun>(rowText(existing, "run_json")), replayed: true };
      }
      const binding = this.database
        .prepare(
          `SELECT normalized_events.world_id AS event_world_id,
                  ai_dm_threads.world_id AS thread_world_id,
                  ai_dm_threads.thread_json AS thread_json
           FROM normalized_events, ai_dm_threads
           WHERE normalized_events.event_id=? AND ai_dm_threads.thread_id=?`,
        )
        .get(run.eventId, run.threadId) as SqlRow | undefined;
      if (!binding) throw new AiDmStorageError("NOT_FOUND", "Run event or thread was not found.");
      const boundThread = parseStoredJson<AiDmThread>(rowText(binding, "thread_json"));
      if (
        rowText(binding, "event_world_id") !== run.principal.worldId ||
        rowText(binding, "thread_world_id") !== run.principal.worldId ||
        !accessAllows(boundThread.participantScope, run.principal.userId, run.principal.isGm)
      ) {
        throw new AiDmStorageError(
          "RUN_SCOPE_INVALID",
          "Run principal is outside the event thread scope.",
        );
      }
      this.database
        .prepare(
          `INSERT INTO ai_dm_runs(
             run_id, event_id, thread_id, attempt, status, status_revision,
             principal_user_id, provider_response_id, provider_response_run_binding,
             cancel_requested_at, failure_code, run_json, create_hash, record_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.runId,
          run.eventId,
          run.threadId,
          run.attempt,
          run.status,
          run.statusRevision,
          run.principal.userId,
          run.providerResponseId,
          run.providerResponseRunBinding,
          run.cancelRequestedAt,
          run.failureCode,
          stored.text,
          stored.digest,
          stored.digest,
          run.createdAt,
          run.updatedAt,
        );
      this.insertRunEvent(run.runId, "created", run.createdAt, { status: run.status });
      return { run: stored.value, replayed: false };
    });
  }

  getRun(runId: string): AiDmRun | null {
    const row = this.database
      .prepare("SELECT run_json FROM ai_dm_runs WHERE run_id = ?")
      .get(runId) as SqlRow | undefined;
    return row ? parseStoredJson<AiDmRun>(rowText(row, "run_json")) : null;
  }

  transitionRun(
    runId: string,
    expectedStatusRevision: number,
    status: AiDmRunStatus,
    occurredAt: string,
    detail: { failureCode?: string | null; cancelRequestedAt?: string | null } = {},
  ): AiDmRun {
    requireTimestamp(occurredAt, "occurredAt");
    return this.transaction(() => {
      const current = this.requireRun(runId);
      if (current.statusRevision !== expectedStatusRevision) {
        throw new AiDmStorageConflictError("Run status revision is stale.", {
          expected: expectedStatusRevision,
          actual: current.statusRevision,
        });
      }
      if (!RUN_TRANSITIONS[current.status].includes(status)) {
        throw new AiDmStorageConflictError("Run status transition is not allowed.", {
          from: current.status,
          to: status,
        });
      }
      const next: AiDmRun = {
        ...current,
        status,
        statusRevision: current.statusRevision + 1,
        updatedAt: occurredAt,
        failureCode: detail.failureCode === undefined ? current.failureCode : detail.failureCode,
        cancelRequestedAt:
          detail.cancelRequestedAt === undefined
            ? current.cancelRequestedAt
            : detail.cancelRequestedAt,
      };
      this.updateRun(next);
      this.insertRunEvent(runId, "status", occurredAt, {
        from: current.status,
        to: status,
        statusRevision: next.statusRevision,
        failureCode: next.failureCode,
      });
      return next;
    });
  }

  bindProviderResponse(
    runId: string,
    responseId: string,
    expectedStatusRevision: number,
    occurredAt: string,
  ): AiDmRun {
    if (!responseId || responseId.length > 512) {
      throw new AiDmStorageError("INVALID_STORAGE_INPUT", "provider response ID is invalid.");
    }
    return this.transaction(() => {
      const current = this.requireRun(runId);
      if (current.statusRevision !== expectedStatusRevision) {
        throw new AiDmStorageConflictError("Run status revision is stale.");
      }
      if (current.providerResponseId && current.providerResponseId !== responseId) {
        throw new AiDmStorageConflictError("Run already has a different provider response chain.");
      }
      const next: AiDmRun = {
        ...current,
        providerResponseId: responseId,
        providerResponseRunBinding: runId,
        statusRevision: current.statusRevision + 1,
        updatedAt: occurredAt,
      };
      this.updateRun(next);
      this.insertRunEvent(runId, "provider-bound", occurredAt, {
        statusRevision: next.statusRevision,
      });
      return next;
    });
  }

  getProviderContinuation(runId: string): string | null {
    const run = this.requireRun(runId);
    if (run.providerResponseId !== null && run.providerResponseRunBinding !== runId) {
      throw new AiDmStorageError(
        "PROVIDER_CHAIN_SCOPE_INVALID",
        "Stored provider response is bound to another run.",
      );
    }
    return run.providerResponseId;
  }

  appendMessage(
    input: AppendMessageInput,
    recipients: readonly MessageRecipient[] = [],
  ): { message: AiDmMessage; deliveries: AiDmServerDelivery[]; replayed: boolean } {
    requireId(input.messageId, "messageId");
    requireId(input.threadId, "threadId");
    requireId(input.eventId, "eventId");
    if (input.runId !== null) requireId(input.runId, "runId");
    requireTimestamp(input.createdAt, "createdAt");
    const stable = prepareStoredJson(input);
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT message_json, record_hash FROM ai_dm_messages WHERE message_id = ?")
        .get(input.messageId) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "record_hash") !== stable.digest) {
          throw new AiDmStorageConflictError("Message identity was reused with different content.");
        }
        return {
          message: parseStoredJson<AiDmMessage>(rowText(existing, "message_json")),
          deliveries: [],
          replayed: true,
        };
      }
      const threadRow = this.database
        .prepare("SELECT world_id, next_message_sequence FROM ai_dm_threads WHERE thread_id = ?")
        .get(input.threadId) as SqlRow | undefined;
      if (!threadRow) throw new AiDmStorageError("NOT_FOUND", "Thread was not found.");
      if (input.runId !== null) {
        const runBinding = this.database
          .prepare("SELECT thread_id, event_id FROM ai_dm_runs WHERE run_id=?")
          .get(input.runId) as SqlRow | undefined;
        if (
          !runBinding ||
          rowText(runBinding, "thread_id") !== input.threadId ||
          rowText(runBinding, "event_id") !== input.eventId
        ) {
          throw new AiDmStorageError(
            "MESSAGE_SCOPE_INVALID",
            "Message run, event, and thread are not bound together.",
          );
        }
      }
      const threadSequence = rowNumber(threadRow, "next_message_sequence");
      const message = prepareStoredJson<AiDmMessage>({ ...input, threadSequence });
      this.database
        .prepare(
          `INSERT INTO ai_dm_messages(
             message_id, thread_id, thread_sequence, run_id, event_id, kind,
             delivery_class, created_at, message_json, record_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.messageId,
          input.threadId,
          threadSequence,
          input.runId,
          input.eventId,
          input.kind,
          input.deliveryClass,
          input.createdAt,
          message.text,
          stable.digest,
        );
      this.database
        .prepare("UPDATE ai_dm_threads SET next_message_sequence = ? WHERE thread_id = ?")
        .run(threadSequence + 1, input.threadId);

      const deliveries = recipients.map((recipient) =>
        this.insertDelivery({
          protocolVersion: AI_DM_PROTOCOL_VERSION,
          deliveryId: recipient.deliveryId,
          recipientUserId: recipient.recipientUserId,
          worldId: rowText(threadRow, "world_id"),
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: input.createdAt,
          message: { type: "aiDm.message.created", payload: message.value },
        }),
      );
      return { message: message.value, deliveries, replayed: false };
    });
  }

  fetchHistory(request: HistoryRequest): HistoryPage {
    requirePositiveInteger(request.limit, "limit", 200);
    const threadRow = this.database
      .prepare("SELECT world_id, thread_json FROM ai_dm_threads WHERE thread_id = ?")
      .get(request.threadId) as SqlRow | undefined;
    if (!threadRow || rowText(threadRow, "world_id") !== request.worldId) {
      throw new AiDmStorageError("NOT_FOUND", "Thread was not found.");
    }
    const thread = parseStoredJson<AiDmThread>(rowText(threadRow, "thread_json"));
    if (!accessAllows(thread.participantScope, request.requesterUserId, request.requesterIsGm)) {
      throw new AiDmStorageError("NOT_FOUND", "Thread was not found.");
    }
    const rows = this.database
      .prepare(
        `SELECT message_json FROM ai_dm_messages
         WHERE thread_id = ? AND thread_sequence > ?
         ORDER BY thread_sequence LIMIT ?`,
      )
      .all(request.threadId, request.afterSequence ?? 0, request.limit + 1) as SqlRow[];
    return {
      messages: rows
        .slice(0, request.limit)
        .map((row) => parseStoredJson<AiDmMessage>(rowText(row, "message_json"))),
      runs: (
        this.database
          .prepare(
            `SELECT run_json FROM ai_dm_runs
             WHERE thread_id = ? OR EXISTS (
               SELECT 1 FROM delivery_outbox
               WHERE delivery_outbox.run_id = ai_dm_runs.run_id
                 AND delivery_outbox.thread_id = ?
                 AND delivery_outbox.recipient_user_id = ?
                 AND delivery_outbox.world_id = ?
             )
             ORDER BY created_at DESC LIMIT 200`,
          )
          .all(
            request.threadId,
            request.threadId,
            request.requesterUserId,
            request.worldId,
          ) as SqlRow[]
      )
        .map((row) => parseStoredJson<AiDmRun>(rowText(row, "run_json")))
        .reverse()
        .map(({ runId, status, failureCode }) => ({ runId, status, failureCode })),
      hasMore: rows.length > request.limit,
    };
  }

  enqueueDelivery(input: EnqueueDeliveryInput): {
    delivery: AiDmServerDelivery;
    replayed: boolean;
  } {
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT delivery_json, record_hash FROM delivery_outbox WHERE delivery_id = ?")
        .get(input.deliveryId) as SqlRow | undefined;
      const stable = prepareStoredJson(input);
      if (existing) {
        if (rowText(existing, "record_hash") !== stable.digest) {
          throw new AiDmStorageConflictError(
            "Delivery identity was reused with different content.",
          );
        }
        return {
          delivery: parseStoredJson<AiDmServerDelivery>(rowText(existing, "delivery_json")),
          replayed: true,
        };
      }
      return { delivery: this.insertDelivery(input), replayed: false };
    });
  }

  leaseDeliveries(input: {
    workerId: string;
    now: string;
    leaseUntil: string;
    limit: number;
  }): LeasedDelivery[] {
    requireId(input.workerId, "workerId");
    requireTimestamp(input.now, "now");
    requireTimestamp(input.leaseUntil, "leaseUntil");
    requirePositiveInteger(input.limit, "limit", 200);
    if (input.leaseUntil <= input.now) {
      throw new AiDmStorageError("INVALID_STORAGE_INPUT", "leaseUntil must be after now.");
    }
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT delivery_id FROM delivery_outbox
           WHERE (status = 'pending' AND available_at <= ?)
              OR (status = 'inflight' AND lease_until <= ?)
           ORDER BY recipient_user_id, recipient_sequence
           LIMIT ?`,
        )
        .all(input.now, input.now, input.limit) as SqlRow[];
      const output: LeasedDelivery[] = [];
      for (const row of rows) {
        const deliveryId = rowText(row, "delivery_id");
        this.database
          .prepare(
            `UPDATE delivery_outbox
             SET status='inflight', attempts=attempts+1, lease_owner=?, lease_until=?, updated_at=?
             WHERE delivery_id=?`,
          )
          .run(input.workerId, input.leaseUntil, input.now, deliveryId);
        const leased = this.database
          .prepare("SELECT delivery_json, attempts FROM delivery_outbox WHERE delivery_id = ?")
          .get(deliveryId) as SqlRow;
        output.push({
          delivery: parseStoredJson<AiDmServerDelivery>(rowText(leased, "delivery_json")),
          attempts: rowNumber(leased, "attempts"),
          leaseOwner: input.workerId,
          leaseUntil: input.leaseUntil,
        });
      }
      return output;
    });
  }

  acknowledgeDelivery(deliveryId: string, workerId: string, deliveredAt: string): void {
    requireTimestamp(deliveredAt, "deliveredAt");
    const changed = this.database
      .prepare(
        `UPDATE delivery_outbox
         SET status='delivered', delivered_at=?, lease_owner=NULL, lease_until=NULL, updated_at=?
         WHERE delivery_id=? AND status='inflight' AND lease_owner=?`,
      )
      .run(deliveredAt, deliveredAt, deliveryId, workerId).changes;
    if (changed !== 1) throw new AiDmStorageConflictError("Delivery lease is no longer owned.");
  }

  failDelivery(
    deliveryId: string,
    workerId: string,
    failedAt: string,
    safeErrorCode: string,
    retryAt: string | null,
  ): void {
    requireTimestamp(failedAt, "failedAt");
    if (retryAt !== null) requireTimestamp(retryAt, "retryAt");
    if (!safeErrorCode || safeErrorCode.length > 160) {
      throw new AiDmStorageError("INVALID_STORAGE_INPUT", "safeErrorCode is invalid.");
    }
    const changed = this.database
      .prepare(
        `UPDATE delivery_outbox
         SET status=?, available_at=?, safe_error_code=?, lease_owner=NULL, lease_until=NULL,
             updated_at=?
         WHERE delivery_id=? AND status='inflight' AND lease_owner=?`,
      )
      .run(
        retryAt === null ? "failed" : "pending",
        retryAt ?? failedAt,
        safeErrorCode,
        failedAt,
        deliveryId,
        workerId,
      ).changes;
    if (changed !== 1) throw new AiDmStorageConflictError("Delivery lease is no longer owned.");
  }

  recordContextReceipt(receipt: AiDmContextReceipt): void {
    const stored = prepareStoredJson(receipt);
    this.insertImmutableBlob(
      "context_receipts",
      "receipt_id",
      receipt.receiptId,
      "receipt_json",
      stored.text,
      stored.digest,
      ["run_id", "completed_at"],
      [receipt.runId, receipt.completedAt],
    );
  }

  recordContinuationCapsule(capsule: AiDmContinuationCapsule): void {
    const stored = prepareStoredJson(capsule);
    this.insertImmutableBlob(
      "continuation_capsules",
      "capsule_id",
      capsule.capsuleId,
      "capsule_json",
      stored.text,
      stored.digest,
      ["run_id", "thread_id", "expires_at"],
      [capsule.priorRunId, capsule.threadId, capsule.expiresAt],
    );
  }

  recordToolSearch(runId: string, result: AiDmToolSearchResult, createdAt: string): void {
    const stored = prepareStoredJson(result);
    this.insertImmutableBlob(
      "tool_searches",
      "search_id",
      result.searchId,
      "search_json",
      stored.text,
      stored.digest,
      ["run_id", "catalog_revision", "policy_view_revision", "created_at"],
      [runId, result.catalogRevision, result.policyViewRevision, createdAt],
    );
  }

  recordLoadedToolDefinition(definition: AiDmLoadedToolDefinition): void {
    const stored = prepareStoredJson(definition);
    this.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT record_hash FROM loaded_tool_definitions
           WHERE run_id=? AND tool_id=? AND tool_revision=?`,
        )
        .get(definition.runId, definition.toolId, definition.revision) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "record_hash") !== stored.digest) {
          throw new AiDmStorageConflictError("Loaded tool receipt conflicts with its prior value.");
        }
        return;
      }
      this.database
        .prepare(
          `INSERT INTO loaded_tool_definitions(
             run_id, tool_id, tool_revision, search_id, loaded_at, definition_json, record_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          definition.runId,
          definition.toolId,
          definition.revision,
          definition.searchId,
          definition.loadedAt,
          stored.text,
          stored.digest,
        );
    });
  }

  beginToolExecution(input: ToolExecutionInput): {
    record: ToolExecutionRecord;
    replayed: boolean;
  } {
    requireId(input.executionId, "executionId");
    requireId(input.runId, "runId");
    requireId(input.toolId, "toolId");
    requireTimestamp(input.createdAt, "createdAt");
    if (input.idempotencyKey !== null) {
      requireBoundedText(input.idempotencyKey, "idempotencyKey");
    }
    if (input.effect === "commit" && input.idempotencyKey === null) {
      throw new AiDmStorageError(
        "IDEMPOTENCY_REQUIRED",
        "Commit tool executions require an idempotency key.",
      );
    }
    const argumentsStored = prepareStoredJson<AiDmJsonValue>(input.arguments);
    const stable = prepareStoredJson({
      runId: input.runId,
      toolId: input.toolId,
      effect: input.effect,
      arguments: argumentsStored.value,
    });
    return this.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM tool_executions
           WHERE execution_id=? OR (idempotency_key IS NOT NULL AND idempotency_key=?)
           LIMIT 1`,
        )
        .get(input.executionId, input.idempotencyKey) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "input_digest") !== stable.digest) {
          throw new AiDmStorageConflictError("Tool execution idempotency key conflicts.");
        }
        return { record: this.toolExecutionFromRow(existing), replayed: true };
      }
      this.database
        .prepare(
          `INSERT INTO tool_executions(
             execution_id, run_id, tool_id, effect, idempotency_key, input_digest,
             state, arguments_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          input.executionId,
          input.runId,
          input.toolId,
          input.effect,
          input.idempotencyKey,
          stable.digest,
          argumentsStored.text,
          input.createdAt,
          input.createdAt,
        );
      return {
        record: {
          ...input,
          arguments: argumentsStored.value,
          state: "pending",
          result: null,
          safeErrorCode: null,
          updatedAt: input.createdAt,
        },
        replayed: false,
      };
    });
  }

  completeToolExecution(
    executionId: string,
    state: "succeeded" | "failed" | "recovery-required",
    result: AiDmJsonValue | null,
    safeErrorCode: string | null,
    updatedAt: string,
  ): ToolExecutionRecord {
    const storedResult = result === null ? null : prepareStoredJson<AiDmJsonValue>(result);
    return this.transaction(() => {
      const current = this.database
        .prepare("SELECT * FROM tool_executions WHERE execution_id=?")
        .get(executionId) as SqlRow | undefined;
      if (!current) throw new AiDmStorageError("NOT_FOUND", "Tool execution was not found.");
      const currentRecord = this.toolExecutionFromRow(current);
      if (currentRecord.state !== "pending") {
        const currentResult =
          currentRecord.result === null ? null : prepareStoredJson(currentRecord.result);
        if (
          currentRecord.state === state &&
          currentResult?.digest === storedResult?.digest &&
          currentRecord.safeErrorCode === safeErrorCode
        ) {
          return currentRecord;
        }
        throw new AiDmStorageConflictError("Tool execution is already terminal.");
      }
      this.database
        .prepare(
          `UPDATE tool_executions
           SET state=?, result_json=?, safe_error_code=?, updated_at=? WHERE execution_id=?`,
        )
        .run(state, storedResult?.text ?? null, safeErrorCode, updatedAt, executionId);
      return {
        ...currentRecord,
        state,
        result: storedResult?.value ?? null,
        safeErrorCode,
        updatedAt,
      };
    });
  }

  createProposal(proposal: AiDmActionProposal): {
    proposal: AiDmActionProposal;
    replayed: boolean;
  } {
    requireId(proposal.proposalId, "proposalId");
    requireId(proposal.runId, "runId");
    requireId(proposal.causeEventId, "causeEventId");
    requireTimestamp(proposal.createdAt, "createdAt");
    requireTimestamp(proposal.expiresAt, "expiresAt");
    const stored = prepareStoredJson<AiDmActionProposal>(proposal);
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT proposal_json, create_hash FROM action_proposals WHERE proposal_id=?")
        .get(proposal.proposalId) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "create_hash") !== stored.digest) {
          throw new AiDmStorageConflictError(
            "Proposal identity was reused with different content.",
          );
        }
        return {
          proposal: parseStoredJson<AiDmActionProposal>(rowText(existing, "proposal_json")),
          replayed: true,
        };
      }
      const runBinding = this.database
        .prepare("SELECT event_id FROM ai_dm_runs WHERE run_id=?")
        .get(proposal.runId) as SqlRow | undefined;
      if (!runBinding || rowText(runBinding, "event_id") !== proposal.causeEventId) {
        throw new AiDmStorageError(
          "PROPOSAL_SCOPE_INVALID",
          "Proposal cause event is not bound to its run.",
        );
      }
      this.database
        .prepare(
          `INSERT INTO action_proposals(
             proposal_id, run_id, cause_event_id, proposal_revision, status, expires_at,
             proposal_json, create_hash, record_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          proposal.proposalId,
          proposal.runId,
          proposal.causeEventId,
          proposal.proposalRevision,
          proposal.status,
          proposal.expiresAt,
          stored.text,
          stored.digest,
          stored.digest,
          proposal.createdAt,
          proposal.createdAt,
        );
      return { proposal: stored.value, replayed: false };
    });
  }

  recordApproval(decision: AiDmApprovalDecision): {
    decision: AiDmApprovalDecision;
    replayed: boolean;
  } {
    requireId(decision.decisionId, "decisionId");
    requireId(decision.proposalId, "proposalId");
    requireId(decision.authenticatedIdentity.userId, "authenticatedIdentity.userId");
    requireId(decision.authenticatedIdentity.worldId, "authenticatedIdentity.worldId");
    requireTimestamp(decision.decidedAt, "decidedAt");
    const stored = prepareStoredJson<AiDmApprovalDecision>(decision);
    const decisionIdentity = prepareStoredJson({
      proposalId: decision.proposalId,
      decision: decision.decision,
      proposalRevision: decision.proposalRevision,
      deciderUserId: decision.authenticatedIdentity.userId,
      worldId: decision.authenticatedIdentity.worldId,
    });
    return this.transaction(() => {
      const proposalRow = this.database
        .prepare(
          `SELECT proposal_json, proposal_revision, action_proposals.status, ai_dm_threads.world_id
           FROM action_proposals
           JOIN ai_dm_runs ON ai_dm_runs.run_id = action_proposals.run_id
           JOIN ai_dm_threads ON ai_dm_threads.thread_id = ai_dm_runs.thread_id
           WHERE proposal_id=?`,
        )
        .get(decision.proposalId) as SqlRow | undefined;
      if (!proposalRow) throw new AiDmStorageError("NOT_FOUND", "Proposal was not found.");
      if (rowText(proposalRow, "proposal_revision") !== decision.proposalRevision) {
        throw new AiDmStorageConflictError("Approval targets a stale proposal revision.");
      }
      const proposal = parseStoredJson<AiDmActionProposal>(rowText(proposalRow, "proposal_json"));
      if (
        rowText(proposalRow, "world_id") !== decision.authenticatedIdentity.worldId ||
        !accessAllows(
          proposal.approvalAuthority,
          decision.authenticatedIdentity.userId,
          decision.authenticatedIdentity.isGm,
        )
      ) {
        throw new AiDmStorageError(
          "APPROVAL_UNAUTHORIZED",
          "Identity may not approve this proposal.",
        );
      }
      const existing = this.database
        .prepare(
          `SELECT decision_json, record_hash FROM approvals
           WHERE decision_id=? OR (proposal_id=? AND decider_user_id=?) LIMIT 1`,
        )
        .get(decision.decisionId, decision.proposalId, decision.authenticatedIdentity.userId) as
        SqlRow | undefined;
      if (existing) {
        const existingDecision = parseStoredJson<AiDmApprovalDecision>(
          rowText(existing, "decision_json"),
        );
        const existingIdentity = prepareStoredJson({
          proposalId: existingDecision.proposalId,
          decision: existingDecision.decision,
          proposalRevision: existingDecision.proposalRevision,
          deciderUserId: existingDecision.authenticatedIdentity.userId,
          worldId: existingDecision.authenticatedIdentity.worldId,
        });
        if (existingIdentity.digest !== decisionIdentity.digest) {
          throw new AiDmStorageConflictError("Approval decision conflicts with its prior value.");
        }
        return {
          decision: parseStoredJson<AiDmApprovalDecision>(rowText(existing, "decision_json")),
          replayed: true,
        };
      }
      this.database
        .prepare(
          `INSERT INTO approvals(
             decision_id, proposal_id, decider_user_id, proposal_revision, decision,
             decided_at, decision_json, record_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.decisionId,
          decision.proposalId,
          decision.authenticatedIdentity.userId,
          decision.proposalRevision,
          decision.decision,
          decision.decidedAt,
          stored.text,
          stored.digest,
        );
      const nextProposal: AiDmActionProposal = {
        ...proposal,
        status: decision.decision === "approve" ? "approved" : "refused",
      };
      const nextStored = prepareStoredJson(nextProposal);
      this.database
        .prepare(
          `UPDATE action_proposals
           SET status=?, proposal_json=?, record_hash=?, updated_at=? WHERE proposal_id=?`,
        )
        .run(
          nextProposal.status,
          nextStored.text,
          nextStored.digest,
          decision.decidedAt,
          decision.proposalId,
        );
      return { decision: stored.value, replayed: false };
    });
  }

  recordCommitReceipt(input: CommitReceiptInput): {
    receipt: CommitReceiptInput;
    replayed: boolean;
  } {
    requireId(input.receiptId, "receiptId");
    requireId(input.proposalId, "proposalId");
    requireId(input.operationId, "operationId");
    requireBoundedText(input.idempotencyKey, "idempotencyKey");
    requireTimestamp(input.createdAt, "createdAt");
    const stored = prepareStoredJson<CommitReceiptInput>(input);
    const idempotentInput = prepareStoredJson({
      proposalId: input.proposalId,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      result: input.result,
    });
    return this.transaction(() => {
      const proposal = this.database
        .prepare("SELECT status FROM action_proposals WHERE proposal_id=?")
        .get(input.proposalId) as SqlRow | undefined;
      if (!proposal) throw new AiDmStorageError("NOT_FOUND", "Proposal was not found.");
      if (!["approved", "committing", "committed"].includes(rowText(proposal, "status"))) {
        throw new AiDmStorageConflictError("Proposal is not approved for commit.");
      }
      const existing = this.database
        .prepare(
          `SELECT receipt_json, input_digest FROM commit_receipts
           WHERE receipt_id=? OR idempotency_key=? OR (proposal_id=? AND operation_id=?) LIMIT 1`,
        )
        .get(input.receiptId, input.idempotencyKey, input.proposalId, input.operationId) as
        SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "input_digest") !== idempotentInput.digest) {
          throw new AiDmStorageConflictError("Commit idempotency key conflicts with prior input.");
        }
        return {
          receipt: parseStoredJson<CommitReceiptInput>(rowText(existing, "receipt_json")),
          replayed: true,
        };
      }
      this.database
        .prepare(
          `INSERT INTO commit_receipts(
             receipt_id, proposal_id, operation_id, idempotency_key, input_digest,
             status, receipt_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.receiptId,
          input.proposalId,
          input.operationId,
          input.idempotencyKey,
          idempotentInput.digest,
          input.status,
          stored.text,
          input.createdAt,
        );
      return { receipt: stored.value, replayed: false };
    });
  }

  recordSynchronizationResult(
    runId: string,
    proposalId: string | null,
    result: AiDmSynchronizationResult,
    updatedAt: string,
  ): void {
    const stored = prepareStoredJson(result);
    this.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT record_hash, status, run_id, proposal_id
           FROM synchronization_results WHERE operation_id=?`,
        )
        .get(result.operationId) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "record_hash") === stored.digest) return;
        if (
          rowText(existing, "run_id") !== runId ||
          (typeof existing["proposal_id"] === "string" ? existing["proposal_id"] : null) !==
            proposalId ||
          !["pending", "recovery-required"].includes(rowText(existing, "status"))
        ) {
          throw new AiDmStorageConflictError("Synchronization result transition is not allowed.");
        }
        this.database
          .prepare(
            `UPDATE synchronization_results
             SET status=?, result_json=?, record_hash=?, updated_at=? WHERE operation_id=?`,
          )
          .run(result.status, stored.text, stored.digest, updatedAt, result.operationId);
      } else {
        this.database
          .prepare(
            `INSERT INTO synchronization_results(
               operation_id, proposal_id, run_id, status, result_json, record_hash, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            result.operationId,
            proposalId,
            runId,
            result.status,
            stored.text,
            stored.digest,
            updatedAt,
          );
      }
      this.database
        .prepare(
          `INSERT INTO synchronization_result_events(
             operation_id, status, result_json, record_hash, recorded_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(result.operationId, result.status, stored.text, stored.digest, updatedAt);
    });
  }

  recordSynchronizationFailure(input: SynchronizationFailureInput): void {
    const details = prepareStoredJson(input.details);
    this.transaction(() => {
      const existing = this.database
        .prepare(
          "SELECT safe_error_code, details_json FROM synchronization_failures WHERE failure_id=?",
        )
        .get(input.failureId) as SqlRow | undefined;
      if (existing) {
        if (
          rowText(existing, "safe_error_code") !== input.safeErrorCode ||
          rowText(existing, "details_json") !== details.text
        ) {
          throw new AiDmStorageConflictError("Synchronization failure identity conflicts.");
        }
        return;
      }
      this.database
        .prepare(
          `INSERT INTO synchronization_failures(
             failure_id, run_id, proposal_id, operation_id, status, safe_error_code,
             details_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(
          input.failureId,
          input.runId,
          input.proposalId,
          input.operationId,
          input.safeErrorCode,
          details.text,
          input.occurredAt,
          input.occurredAt,
        );
    });
  }

  resolveSynchronizationFailure(failureId: string, resolvedAt: string): void {
    requireId(failureId, "failureId");
    requireTimestamp(resolvedAt, "resolvedAt");
    const row = this.database
      .prepare("SELECT status FROM synchronization_failures WHERE failure_id=?")
      .get(failureId) as SqlRow | undefined;
    if (!row) throw new AiDmStorageError("NOT_FOUND", "Synchronization failure was not found.");
    if (rowText(row, "status") === "resolved") return;
    this.database
      .prepare(
        `UPDATE synchronization_failures
         SET status='resolved', resolved_at=?, updated_at=? WHERE failure_id=?`,
      )
      .run(resolvedAt, resolvedAt, failureId);
  }

  recoverInterruptedWork(now: string): RecoverySummary {
    requireTimestamp(now, "now");
    return this.transaction(() => {
      let failedRuns = 0;
      let uncertainCommits = 0;
      let toolExecutionsNeedingReconciliation = 0;

      const runRows = this.database
        .prepare(
          `SELECT run_json FROM ai_dm_runs
           WHERE status IN ('projecting','reading-context','searching-tools','resolving','committing','delivering')`,
        )
        .all() as SqlRow[];
      for (const row of runRows) {
        const run = parseStoredJson<AiDmRun>(rowText(row, "run_json"));
        const committing = run.status === "committing";
        const next: AiDmRun = {
          ...run,
          status: "failed",
          statusRevision: run.statusRevision + 1,
          failureCode: committing ? "COMMIT_RECONCILIATION_REQUIRED" : "SERVER_RESTARTED",
          updatedAt: now,
        };
        this.updateRun(next);
        this.insertRunEvent(run.runId, "recovery", now, { priorStatus: run.status });
        if (committing) {
          uncertainCommits += 1;
          this.insertRecoveryMarker("run", run.runId, "COMMIT_RECONCILIATION_REQUIRED", now, {
            priorStatus: run.status,
          });
        }
        failedRuns += 1;
      }

      const executionRows = this.database
        .prepare("SELECT * FROM tool_executions WHERE state='pending'")
        .all() as SqlRow[];
      for (const row of executionRows) {
        const effect = rowText(row, "effect") as AiDmToolEffect;
        const executionId = rowText(row, "execution_id");
        const consequential = effect === "present" || effect === "propose" || effect === "commit";
        this.database
          .prepare(
            `UPDATE tool_executions SET state=?, safe_error_code=?, updated_at=?
             WHERE execution_id=?`,
          )
          .run(
            consequential ? "recovery-required" : "failed",
            consequential ? "EXECUTION_RECONCILIATION_REQUIRED" : "SERVER_RESTARTED",
            now,
            executionId,
          );
        if (consequential) {
          toolExecutionsNeedingReconciliation += 1;
          this.insertRecoveryMarker(
            "tool-execution",
            executionId,
            "EXECUTION_RECONCILIATION_REQUIRED",
            now,
            { effect },
          );
        }
      }

      const proposalRows = this.database
        .prepare("SELECT proposal_json FROM action_proposals WHERE status='committing'")
        .all() as SqlRow[];
      for (const row of proposalRows) {
        const proposal = parseStoredJson<AiDmActionProposal>(rowText(row, "proposal_json"));
        const next = prepareStoredJson<AiDmActionProposal>({ ...proposal, status: "conflicted" });
        this.database
          .prepare(
            `UPDATE action_proposals SET status='conflicted', proposal_json=?, record_hash=?, updated_at=?
             WHERE proposal_id=?`,
          )
          .run(next.text, next.digest, now, proposal.proposalId);
        this.insertRecoveryMarker(
          "proposal",
          proposal.proposalId,
          "COMMIT_RECONCILIATION_REQUIRED",
          now,
          {},
        );
      }

      const recoveredOutboxRows = Number(
        this.database
          .prepare(
            `UPDATE delivery_outbox
             SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=?
             WHERE status='inflight' AND lease_until <= ?`,
          )
          .run(now, now).changes,
      );
      return {
        failedRuns,
        uncertainCommits,
        recoveredOutboxRows,
        toolExecutionsNeedingReconciliation,
      };
    });
  }

  private requireRun(runId: string): AiDmRun {
    const run = this.getRun(runId);
    if (!run) throw new AiDmStorageError("NOT_FOUND", "Run was not found.");
    return run;
  }

  private updateRun(run: AiDmRun): void {
    const stored = prepareStoredJson(run);
    this.database
      .prepare(
        `UPDATE ai_dm_runs SET
           status=?, status_revision=?, provider_response_id=?, provider_response_run_binding=?,
           cancel_requested_at=?, failure_code=?, run_json=?, record_hash=?, updated_at=?
         WHERE run_id=?`,
      )
      .run(
        run.status,
        run.statusRevision,
        run.providerResponseId,
        run.providerResponseRunBinding,
        run.cancelRequestedAt,
        run.failureCode,
        stored.text,
        stored.digest,
        run.updatedAt,
        run.runId,
      );
  }

  private insertRunEvent(runId: string, kind: string, occurredAt: string, payload: unknown): void {
    const stored = prepareStoredJson(payload);
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next FROM ai_dm_run_events WHERE run_id=?",
      )
      .get(runId) as SqlRow;
    this.database
      .prepare(
        `INSERT INTO ai_dm_run_events(
           run_id, run_sequence, kind, occurred_at, payload_json, payload_hash
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, rowNumber(row, "next"), kind, occurredAt, stored.text, stored.digest);
  }

  private insertDelivery(input: EnqueueDeliveryInput): AiDmServerDelivery {
    requireId(input.deliveryId, "deliveryId");
    requireId(input.recipientUserId, "recipientUserId");
    requireTimestamp(input.occurredAt, "occurredAt");
    const stable = prepareStoredJson(input);
    this.database
      .prepare(
        `INSERT INTO recipient_streams(world_id, recipient_user_id, next_sequence)
         VALUES (?, ?, 1) ON CONFLICT(world_id, recipient_user_id) DO NOTHING`,
      )
      .run(input.worldId, input.recipientUserId);
    const stream = this.database
      .prepare(
        "SELECT next_sequence FROM recipient_streams WHERE world_id=? AND recipient_user_id=?",
      )
      .get(input.worldId, input.recipientUserId) as SqlRow;
    const recipientSequence = rowNumber(stream, "next_sequence");
    const delivery = prepareStoredJson<AiDmServerDelivery>({ ...input, recipientSequence });
    this.database
      .prepare(
        `INSERT INTO delivery_outbox(
           delivery_id, world_id, recipient_user_id, recipient_sequence, thread_id, run_id,
           status, available_at, delivery_json, record_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.deliveryId,
        input.worldId,
        input.recipientUserId,
        recipientSequence,
        input.threadId,
        input.runId,
        input.occurredAt,
        delivery.text,
        stable.digest,
        input.occurredAt,
        input.occurredAt,
      );
    this.database
      .prepare(
        `UPDATE recipient_streams SET next_sequence=?
         WHERE world_id=? AND recipient_user_id=?`,
      )
      .run(recipientSequence + 1, input.worldId, input.recipientUserId);
    return delivery.value;
  }

  private insertImmutableBlob(
    table: string,
    idColumn: string,
    id: string,
    jsonColumn: string,
    json: string,
    digest: string,
    columns: readonly string[],
    values: readonly (string | number | null)[],
  ): void {
    // All table/column names are fixed internal literals from the call sites above.
    this.transaction(() => {
      const existing = this.database
        .prepare(`SELECT record_hash FROM ${table} WHERE ${idColumn}=?`)
        .get(id) as SqlRow | undefined;
      if (existing) {
        if (rowText(existing, "record_hash") !== digest) {
          throw new AiDmStorageConflictError(`${table} identity conflicts with its prior value.`);
        }
        return;
      }
      const allColumns = [idColumn, ...columns, jsonColumn, "record_hash"];
      const placeholders = allColumns.map(() => "?").join(",");
      this.database
        .prepare(`INSERT INTO ${table}(${allColumns.join(",")}) VALUES (${placeholders})`)
        .run(id, ...values, json, digest);
    });
  }

  private toolExecutionFromRow(row: SqlRow): ToolExecutionRecord {
    return {
      executionId: rowText(row, "execution_id"),
      runId: rowText(row, "run_id"),
      toolId: rowText(row, "tool_id"),
      effect: rowText(row, "effect") as AiDmToolEffect,
      idempotencyKey: typeof row["idempotency_key"] === "string" ? row["idempotency_key"] : null,
      arguments: parseStoredJson<AiDmJsonValue>(rowText(row, "arguments_json")),
      createdAt: rowText(row, "created_at"),
      state: rowText(row, "state") as ToolExecutionRecord["state"],
      result:
        typeof row["result_json"] === "string"
          ? parseStoredJson<AiDmJsonValue>(row["result_json"])
          : null,
      safeErrorCode: typeof row["safe_error_code"] === "string" ? row["safe_error_code"] : null,
      updatedAt: rowText(row, "updated_at"),
    };
  }

  private insertRecoveryMarker(
    subjectKind: string,
    subjectId: string,
    code: string,
    createdAt: string,
    details: unknown,
  ): void {
    const stored = prepareStoredJson(details);
    this.database
      .prepare(
        `INSERT INTO recovery_markers(
           subject_kind, subject_id, code, status, details_json, created_at
         ) VALUES (?, ?, ?, 'open', ?, ?)
         ON CONFLICT(subject_kind, subject_id, code) DO NOTHING`,
      )
      .run(subjectKind, subjectId, code, stored.text, createdAt);
  }
}

export function makeDeliveryInput(input: {
  deliveryId?: string;
  recipientUserId: string;
  worldId: string;
  threadId: string | null;
  runId: string | null;
  occurredAt: string;
  message: AiDmServerPayload;
}): EnqueueDeliveryInput {
  return {
    protocolVersion: AI_DM_PROTOCOL_VERSION,
    deliveryId: input.deliveryId ?? randomUUID(),
    recipientUserId: input.recipientUserId,
    worldId: input.worldId,
    threadId: input.threadId,
    runId: input.runId,
    occurredAt: input.occurredAt,
    message: input.message,
  };
}
