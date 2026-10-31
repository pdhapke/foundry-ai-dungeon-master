import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SequencedMovementEvent } from "../../../../foundry-local-api/shared/dist/index.js";
import type { MovementStore as MovementEventStore } from "./api-contract.js";

export type DeliveryState = "queued" | "in_flight" | "retry_wait" | "acknowledged" | "dead_letter";

export interface PendingFirstStop {
  reason: string;
  acceptedPoint: { x: number; y: number; elevation?: number };
  remainingPath: Array<{ x: number; y: number; elevation?: number }>;
}

export interface PendingAdjudication {
  status: "pending_adjudication";
  firstStop?: PendingFirstStop;
  automaticConsequencesApplied: false;
}

export interface DeliveryAttempt {
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  outcome?: "acknowledged" | "retry_scheduled" | "dead_letter" | "interrupted";
  errorCode?: string;
  message?: string;
}

export interface AiGmDeliveryItem {
  id: string;
  consumerId: string;
  eventId: string;
  eventSequence: number;
  eventCursor: string;
  event: SequencedMovementEvent;
  state: DeliveryState;
  adjudication: PendingAdjudication;
  attemptHistory: DeliveryAttempt[];
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  acknowledgementId?: string;
  acknowledgedAt?: number;
  deadLetteredAt?: number;
  lastFailure?: { code: string; message: string; retryable: boolean };
}

export interface DeliveryReconciliationWatermark {
  generation: string;
  sequence: number;
  cursor: string;
  initializedAt: number;
  updatedAt: number;
}

interface DeliveryFile {
  version: 2;
  consumerId: string;
  items: AiGmDeliveryItem[];
  reconciliationWatermark?: DeliveryReconciliationWatermark;
}

export interface HostDeliveryRequest {
  consumerId: string;
  deliveryId: string;
  eventId: string;
  eventSequence: number;
  eventCursor: string;
  event: SequencedMovementEvent;
  adjudication: PendingAdjudication;
  attempt: number;
  deadlineAt: number;
}

export type HostDeliveryResult =
  | { status: "acknowledged"; acknowledgementId: string }
  | { status: "rejected"; code: string; message: string; retryable: boolean };

export interface HostWakeAdapter {
  readonly capability: "invoke" | "wake" | "unavailable";
  readonly limitation?: string;
  deliver(request: HostDeliveryRequest, signal: AbortSignal): Promise<HostDeliveryResult>;
}

export class UnavailableHostWakeAdapter implements HostWakeAdapter {
  readonly capability = "unavailable" as const;

  constructor(readonly limitation: string) {}

  deliver(): Promise<HostDeliveryResult> {
    return Promise.resolve({
      status: "rejected",
      code: "HOST_INVOCATION_UNAVAILABLE",
      message: this.limitation,
      retryable: true,
    });
  }
}

export interface AiGmDeliveryOptions {
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

export interface DeliverySyncResult {
  created: AiGmDeliveryItem[];
  existing: AiGmDeliveryItem[];
  nextCursor: string;
  gap?: { code: "CURSOR_GAP"; reason: "restart" | "expired"; oldestSequence: number };
}

export interface DeliveryReconciliationResult extends DeliverySyncResult {
  watermark: DeliveryReconciliationWatermark;
  pagesRead: number;
}

export interface DeliveryRunResult {
  attempted: number;
  acknowledged: number;
  retryScheduled: number;
  deadLettered: number;
}

export interface DeliveryQueueSummary {
  total: number;
  pendingAdjudication: number;
  states: Record<DeliveryState, number>;
  reconciliationWatermark: DeliveryReconciliationWatermark | null;
}

const PREPARATION_EVENT = {
  sceneId: "Nbj38PEdvw1zX1J9",
  tokenId: "mRgn9lP9y9fY3jcw",
  userId: "X7X4KK7zca5U2Ics",
  from: { x: 450, y: 650, elevation: 0 },
  to: { x: 500, y: 500, elevation: 0 },
} as const;

function safeText(value: string, fallback: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return (normalized || fallback).slice(0, 500);
}

function deliveryId(consumerId: string, eventId: string): string {
  return `ai-gm-${createHash("sha256").update(`${consumerId}\0${eventId}`).digest("hex").slice(0, 24)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class AiGmDeliveryService {
  private readonly maxAttempts: number;
  private readonly attemptTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private state: DeliveryFile;
  private migrationNeeded = false;

  constructor(
    private readonly path: string,
    readonly consumerId: string,
    options: AiGmDeliveryOptions = {},
  ) {
    if (!consumerId.trim()) throw new Error("AI-GM consumer identity is required.");
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs ?? 5_000);
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? 1_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 60_000);
    this.now = options.now ?? Date.now;
    this.state = this.load();
    if (this.migrationNeeded) this.save(this.state);
    this.recoverInterruptedAttempts();
  }

  private load(): DeliveryFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 2, consumerId: this.consumerId, items: [] };
      throw new Error(`Unable to read AI-GM delivery store: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`AI-GM delivery store is corrupt: ${(error as Error).message}`);
    }
    if (this.isLegacyDeliveryFile(parsed)) {
      this.migrationNeeded = true;
      parsed = { ...parsed, version: 2 };
    }
    if (!this.isDeliveryFile(parsed))
      throw new Error("AI-GM delivery store has an invalid schema.");
    if (parsed.consumerId !== this.consumerId)
      throw new Error(
        `AI-GM delivery store belongs to consumer ${parsed.consumerId}, not ${this.consumerId}.`,
      );
    return parsed;
  }

  private isDeliveryFile(value: unknown): value is DeliveryFile {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DeliveryFile>;
    return (
      candidate.version === 2 &&
      typeof candidate.consumerId === "string" &&
      Array.isArray(candidate.items) &&
      (candidate.reconciliationWatermark === undefined ||
        this.isReconciliationWatermark(candidate.reconciliationWatermark)) &&
      candidate.items.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.eventId === "string" &&
          typeof item.eventSequence === "number" &&
          Array.isArray(item.attemptHistory),
      )
    );
  }

  private isLegacyDeliveryFile(
    value: unknown,
  ): value is Omit<DeliveryFile, "version" | "reconciliationWatermark"> & { version: 1 } {
    if (!value || typeof value !== "object") return false;
    const candidate = value as { version?: unknown; consumerId?: unknown; items?: unknown };
    return (
      candidate.version === 1 &&
      typeof candidate.consumerId === "string" &&
      Array.isArray(candidate.items)
    );
  }

  private isReconciliationWatermark(value: unknown): value is DeliveryReconciliationWatermark {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DeliveryReconciliationWatermark>;
    return (
      typeof candidate.generation === "string" &&
      candidate.generation.length > 0 &&
      Number.isSafeInteger(candidate.sequence) &&
      (candidate.sequence ?? -1) >= 0 &&
      typeof candidate.cursor === "string" &&
      typeof candidate.initializedAt === "number" &&
      typeof candidate.updatedAt === "number"
    );
  }

  private save(state: DeliveryFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created or may already have been renamed.
      }
      throw error;
    }
  }

  private commit(mutator: (next: DeliveryFile) => void): void {
    const next = clone(this.state);
    mutator(next);
    this.save(next);
    this.state = next;
  }

  private recoverInterruptedAttempts(): void {
    const recoveredAt = this.now();
    if (!this.state.items.some((item) => item.state === "in_flight")) return;
    this.commit((next) => {
      for (const item of next.items) {
        if (item.state !== "in_flight") continue;
        const attempt = item.attemptHistory.at(-1);
        if (attempt && attempt.finishedAt === undefined) {
          attempt.finishedAt = recoveredAt;
          attempt.outcome = "interrupted";
          attempt.errorCode = "HOST_PROCESS_INTERRUPTED";
          attempt.message = "Delivery attempt was interrupted before acknowledgement.";
        }
        item.state = "retry_wait";
        item.nextAttemptAt = recoveredAt;
        item.updatedAt = recoveredAt;
        item.lastFailure = {
          code: "HOST_PROCESS_INTERRUPTED",
          message: "Delivery attempt was interrupted before acknowledgement.",
          retryable: true,
        };
      }
    });
  }

  enqueue(
    event: SequencedMovementEvent,
    eventCursor: string,
    firstStop?: PendingFirstStop,
  ): { item: AiGmDeliveryItem; created: boolean } {
    const id = deliveryId(this.consumerId, event.eventId);
    const prior = this.state.items.find((item) => item.id === id);
    if (prior) {
      if (prior.eventSequence !== event.sequence || prior.eventCursor !== eventCursor)
        throw new Error(`Movement event ${event.eventId} was replayed with conflicting linkage.`);
      return { item: clone(prior), created: false };
    }
    const timestamp = this.now();
    const item: AiGmDeliveryItem = {
      id,
      consumerId: this.consumerId,
      eventId: event.eventId,
      eventSequence: event.sequence,
      eventCursor,
      event: clone(event),
      state: "queued",
      adjudication: {
        status: "pending_adjudication",
        ...(firstStop ? { firstStop: clone(firstStop) } : {}),
        automaticConsequencesApplied: false,
      },
      attemptHistory: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      nextAttemptAt: timestamp,
    };
    this.commit((next) => next.items.push(item));
    return { item: clone(item), created: true };
  }

  syncFromMovementStore(
    store: Pick<MovementEventStore, "cursor" | "query">,
    cursor?: string,
  ): DeliverySyncResult {
    const page = store.query({ ...(cursor ? { cursor } : {}), limit: 500 });
    const created: AiGmDeliveryItem[] = [];
    const existing: AiGmDeliveryItem[] = [];
    for (const event of page.events) {
      const result = this.enqueue(event, store.cursor(event.sequence));
      (result.created ? created : existing).push(result.item);
    }
    return {
      created,
      existing,
      nextCursor: page.nextCursor,
      ...(page.gap ? { gap: page.gap } : {}),
    };
  }

  initializeReconciliationWatermark(
    store: Pick<MovementEventStore, "cursor" | "generation" | "query">,
    excludeThroughSequence: number,
  ): { watermark: DeliveryReconciliationWatermark; initialized: boolean } {
    if (!Number.isSafeInteger(excludeThroughSequence) || excludeThroughSequence < 0)
      throw new Error("Delivery reconciliation watermark must be a non-negative integer.");
    const existing = this.state.reconciliationWatermark;
    if (existing) return { watermark: clone(existing), initialized: false };
    if (excludeThroughSequence > 1)
      throw new Error(
        "Delivery reconciliation can exclude only the guarded preparation event at sequence 1.",
      );
    let initialSequence = 0;
    if (excludeThroughSequence === 1) {
      const firstPage = store.query({ cursor: store.cursor(0), limit: 1 });
      if (!firstPage.gap && this.isGuardedPreparationEvent(firstPage.events[0]))
        initialSequence = 1;
    }
    const timestamp = this.now();
    const watermark: DeliveryReconciliationWatermark = {
      generation: store.generation,
      sequence: initialSequence,
      cursor: store.cursor(initialSequence),
      initializedAt: timestamp,
      updatedAt: timestamp,
    };
    this.commit((next) => {
      next.reconciliationWatermark = watermark;
    });
    return { watermark: clone(watermark), initialized: true };
  }

  private isGuardedPreparationEvent(event: SequencedMovementEvent | undefined): boolean {
    if (
      !event ||
      event.sequence !== 1 ||
      event.eventType !== "token_movement" ||
      event.sceneId !== PREPARATION_EVENT.sceneId ||
      event.tokenId !== PREPARATION_EVENT.tokenId ||
      event.userId !== PREPARATION_EVENT.userId ||
      event.waypoints.length !== 2
    )
      return false;
    const [from, to] = event.waypoints;
    return this.samePoint(from, PREPARATION_EVENT.from) && this.samePoint(to, PREPARATION_EVENT.to);
  }

  private samePoint(
    actual: { x: number; y: number; elevation?: number } | undefined,
    expected: { x: number; y: number; elevation: number },
  ): boolean {
    return (
      actual?.x === expected.x && actual.y === expected.y && actual.elevation === expected.elevation
    );
  }

  getReconciliationWatermark(): DeliveryReconciliationWatermark | undefined {
    const watermark = this.state.reconciliationWatermark;
    return watermark ? clone(watermark) : undefined;
  }

  /** Counts queue state in place without cloning or exposing the durable item collection. */
  getQueueSummary(): DeliveryQueueSummary {
    const states: Record<DeliveryState, number> = {
      queued: 0,
      in_flight: 0,
      retry_wait: 0,
      acknowledged: 0,
      dead_letter: 0,
    };
    let pendingAdjudication = 0;
    for (const item of this.state.items) {
      states[item.state] += 1;
      if (item.adjudication.status === "pending_adjudication") pendingAdjudication += 1;
    }
    const watermark = this.state.reconciliationWatermark;
    return {
      total: this.state.items.length,
      pendingAdjudication,
      states,
      reconciliationWatermark: watermark ? clone(watermark) : null,
    };
  }

  reconcileMovementStore(
    store: Pick<MovementEventStore, "cursor" | "generation" | "query">,
  ): DeliveryReconciliationResult {
    const initial = this.state.reconciliationWatermark;
    if (!initial)
      throw new Error(
        "AI-GM delivery reconciliation is not initialized; set the intentional exclusion watermark first.",
      );
    if (initial.generation !== store.generation)
      throw new Error(
        `Movement generation changed from ${initial.generation} to ${store.generation}; the cross-generation missing range is unknown and explicit reconciliation is required.`,
      );

    const created: AiGmDeliveryItem[] = [];
    const existing: AiGmDeliveryItem[] = [];
    let cursor = initial.cursor;
    let pagesRead = 0;
    for (;;) {
      const page = store.query({ cursor, limit: 500 });
      pagesRead += 1;
      if (page.gap)
        throw new Error(
          page.gap.reason === "expired"
            ? `Movement delivery reconciliation encountered exact expired gap ${page.gap.missingRanges.map((range) => `${range.fromSequence}-${range.toSequence}`).join(",")} from sequence ${initial.sequence}; explicit reconciliation is required.`
            : `Movement delivery reconciliation encountered a cross-generation gap with an unknown missing range from sequence ${initial.sequence}; explicit reconciliation is required.`,
        );
      for (const event of page.events) {
        const eventCursor = store.cursor(event.sequence);
        const result = this.enqueue(event, eventCursor, this.pendingFirstStop(event));
        (result.created ? created : existing).push(result.item);
        this.advanceReconciliationWatermark(store.generation, event.sequence, eventCursor);
      }
      if (page.events.length < 500) {
        const finalSequence = this.sequenceFromCursor(page.nextCursor, store.generation);
        if (finalSequence > this.state.reconciliationWatermark!.sequence)
          this.advanceReconciliationWatermark(store.generation, finalSequence, page.nextCursor);
        cursor = page.nextCursor;
        break;
      }
      const nextSequence = this.sequenceFromCursor(page.nextCursor, store.generation);
      if (nextSequence <= this.state.reconciliationWatermark!.sequence)
        throw new Error("Movement delivery reconciliation did not advance its cursor.");
      cursor = page.nextCursor;
    }
    return {
      created,
      existing,
      nextCursor: cursor,
      watermark: clone(this.state.reconciliationWatermark!),
      pagesRead,
    };
  }

  private pendingFirstStop(event: SequencedMovementEvent): PendingFirstStop | undefined {
    if (!event.firstStop) return undefined;
    return {
      reason: `${event.firstStop.category}:${event.firstStop.kind}:${event.firstStop.regionId}`,
      acceptedPoint: clone(event.acceptedPoint),
      remainingPath: clone(event.remainingPath),
    };
  }

  private advanceReconciliationWatermark(
    generation: string,
    sequence: number,
    cursor: string,
  ): void {
    const watermark = this.state.reconciliationWatermark;
    if (!watermark) throw new Error("AI-GM delivery reconciliation is not initialized.");
    if (generation !== watermark.generation || sequence < watermark.sequence)
      throw new Error(
        "AI-GM delivery reconciliation watermark cannot move backward or generations.",
      );
    this.commit((next) => {
      const nextWatermark = next.reconciliationWatermark!;
      nextWatermark.sequence = sequence;
      nextWatermark.cursor = cursor;
      nextWatermark.updatedAt = this.now();
    });
  }

  private sequenceFromCursor(cursor: string, generation: string): number {
    const split = cursor.lastIndexOf(":");
    const cursorGeneration = cursor.slice(0, split);
    const sequence = Number(cursor.slice(split + 1));
    if (
      split < 1 ||
      cursorGeneration !== generation ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      throw new Error("Movement store returned an invalid reconciliation cursor.");
    return sequence;
  }

  list(states?: DeliveryState[]): AiGmDeliveryItem[] {
    const allowed = states ? new Set(states) : undefined;
    return this.state.items.filter((item) => !allowed || allowed.has(item.state)).map(clone);
  }

  get(id: string): AiGmDeliveryItem | undefined {
    const item = this.state.items.find((candidate) => candidate.id === id);
    return item ? clone(item) : undefined;
  }

  acknowledge(id: string, acknowledgementId: string): AiGmDeliveryItem {
    const item = this.requireItem(id);
    if (item.state === "acknowledged") {
      if (item.acknowledgementId !== acknowledgementId)
        throw new Error(`Delivery ${id} is already acknowledged with a different acknowledgement.`);
      return clone(item);
    }
    if (item.state === "dead_letter") throw new Error(`Delivery ${id} is dead-lettered.`);
    const timestamp = this.now();
    this.commit((next) => {
      const nextItem = next.items.find((candidate) => candidate.id === id)!;
      nextItem.state = "acknowledged";
      nextItem.acknowledgementId = safeText(acknowledgementId, "acknowledged");
      nextItem.acknowledgedAt = timestamp;
      nextItem.updatedAt = timestamp;
      delete nextItem.nextAttemptAt;
      delete nextItem.lastFailure;
    });
    return clone(this.requireItem(id));
  }

  currentTime(): number {
    return this.now();
  }

  /**
   * Hold queued work until `until`. Used to keep a token's in-progress drag
   * together; retries already scheduled later stay on that later time.
   */
  deferUntil(ids: readonly string[], until: number): void {
    if (!Number.isFinite(until) || ids.length === 0) return;
    const wanted = new Set(ids);
    const timestamp = this.now();
    const changes = this.state.items.some((item) => {
      if (!wanted.has(item.id)) return false;
      if (item.state !== "queued" && item.state !== "retry_wait") return false;
      return (item.nextAttemptAt ?? 0) < until;
    });
    if (!changes) return;
    this.commit((next) => {
      for (const item of next.items) {
        if (!wanted.has(item.id)) continue;
        if (item.state !== "queued" && item.state !== "retry_wait") continue;
        if ((item.nextAttemptAt ?? 0) >= until) continue;
        item.nextAttemptAt = until;
        item.updatedAt = timestamp;
      }
    });
  }

  async dispatchDue(
    adapter: HostWakeAdapter,
    limit = 25,
    only?: ReadonlySet<string>,
  ): Promise<DeliveryRunResult> {
    const result: DeliveryRunResult = {
      attempted: 0,
      acknowledged: 0,
      retryScheduled: 0,
      deadLettered: 0,
    };
    const due = this.state.items
      .filter(
        (item) =>
          (item.state === "queued" || item.state === "retry_wait") &&
          (item.nextAttemptAt ?? 0) <= this.now() &&
          (!only || only.has(item.id)),
      )
      .slice(0, Math.max(0, limit));
    for (const item of due) {
      result.attempted += 1;
      const outcome = await this.dispatchOne(item, adapter);
      if (outcome === "acknowledged") result.acknowledged += 1;
      else if (outcome === "retry_wait") result.retryScheduled += 1;
      else result.deadLettered += 1;
    }
    return result;
  }

  private async dispatchOne(
    item: AiGmDeliveryItem,
    adapter: HostWakeAdapter,
  ): Promise<"acknowledged" | "retry_wait" | "dead_letter"> {
    const attemptNumber = item.attemptHistory.length + 1;
    const startedAt = this.now();
    this.commit((next) => {
      const nextItem = next.items.find((candidate) => candidate.id === item.id)!;
      nextItem.state = "in_flight";
      nextItem.updatedAt = startedAt;
      delete nextItem.nextAttemptAt;
      nextItem.attemptHistory.push({ attempt: attemptNumber, startedAt });
    });

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: HostDeliveryResult;
    try {
      response = await Promise.race([
        adapter.deliver(
          {
            consumerId: this.consumerId,
            deliveryId: item.id,
            eventId: item.eventId,
            eventSequence: item.eventSequence,
            eventCursor: item.eventCursor,
            event: clone(item.event),
            adjudication: clone(item.adjudication),
            attempt: attemptNumber,
            deadlineAt: startedAt + this.attemptTimeoutMs,
          },
          controller.signal,
        ),
        new Promise<HostDeliveryResult>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              status: "rejected",
              code: "HOST_INVOCATION_TIMEOUT",
              message: `Host did not acknowledge within ${this.attemptTimeoutMs}ms.`,
              retryable: true,
            });
            controller.abort();
          }, this.attemptTimeoutMs);
        }),
      ]);
    } catch (error) {
      response = {
        status: "rejected",
        code: "HOST_INVOCATION_FAILED",
        message: error instanceof Error ? error.message : "Host invocation failed.",
        retryable: true,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const finishedAt = this.now();
    if (response.status === "acknowledged") {
      this.commit((next) => {
        const nextItem = next.items.find((candidate) => candidate.id === item.id)!;
        const nextAttempt = nextItem.attemptHistory.at(-1)!;
        nextAttempt.finishedAt = finishedAt;
        nextAttempt.outcome = "acknowledged";
        nextItem.state = "acknowledged";
        nextItem.acknowledgementId = safeText(response.acknowledgementId, "acknowledged");
        nextItem.acknowledgedAt = finishedAt;
        nextItem.updatedAt = finishedAt;
        delete nextItem.lastFailure;
      });
      return "acknowledged";
    }

    const retryable = response.retryable && attemptNumber < this.maxAttempts;
    const errorCode = safeText(response.code, "HOST_INVOCATION_FAILED");
    const message = safeText(response.message, "Host invocation failed.");
    if (retryable) {
      this.commit((next) => {
        const nextItem = next.items.find((candidate) => candidate.id === item.id)!;
        const nextAttempt = nextItem.attemptHistory.at(-1)!;
        nextAttempt.finishedAt = finishedAt;
        nextAttempt.outcome = "retry_scheduled";
        nextAttempt.errorCode = errorCode;
        nextAttempt.message = message;
        nextItem.lastFailure = { code: errorCode, message, retryable: response.retryable };
        nextItem.updatedAt = finishedAt;
        nextItem.state = "retry_wait";
        nextItem.nextAttemptAt = finishedAt + this.retryDelay(attemptNumber);
      });
      return "retry_wait";
    }
    this.commit((next) => {
      const nextItem = next.items.find((candidate) => candidate.id === item.id)!;
      const nextAttempt = nextItem.attemptHistory.at(-1)!;
      nextAttempt.finishedAt = finishedAt;
      nextAttempt.outcome = "dead_letter";
      nextAttempt.errorCode = errorCode;
      nextAttempt.message = message;
      nextItem.lastFailure = { code: errorCode, message, retryable: response.retryable };
      nextItem.updatedAt = finishedAt;
      nextItem.state = "dead_letter";
      nextItem.deadLetteredAt = finishedAt;
      delete nextItem.nextAttemptAt;
    });
    return "dead_letter";
  }

  private retryDelay(attemptNumber: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, attemptNumber - 1));
  }

  private requireItem(id: string): AiGmDeliveryItem {
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Unknown AI-GM delivery ${id}.`);
    return item;
  }
}
