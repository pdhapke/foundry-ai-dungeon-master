import type { SequencedMovementEvent } from "../../../../foundry-local-api/shared/dist/index.js";
import {
  AiGmDeliveryService,
  UnavailableHostWakeAdapter,
  type DeliveryRunResult,
  type HostDeliveryRequest,
  type HostDeliveryResult,
  type HostWakeAdapter,
} from "./ai-gm-delivery.js";
import {
  loadWakeWebhookConfig,
  wakeCredentialHeader,
  type WakeWebhookConfig,
} from "./wake-webhook-config.js";

export interface WakePoint {
  x: number;
  y: number;
  elevation?: number;
}

/** JSON body posted to the external AI Dungeon Master. */
export interface AiDmWakePayload {
  type: "token_movement" | "chat_message" | "combat_turn";
  worldId: string | null;
  sceneId: string | null;
  tokenId: string | null;
  actorId: string | null;
  userId: string | null;
  userName: string | null;
  from: WakePoint | null;
  to: WakePoint | null;
  path: WakePoint[];
  sequence: number | null;
  cursor: string | null;
  timestamp: string;
  deliveryId: string;
  eventId: string;
  attempt: number;
  coalescedEventIds: string[];
  messageId?: string;
  content?: string;
  combatId?: string;
  round?: number;
  turn?: number;
  combatantId?: string;
  /** Every event type folded into this wake, oldest first. */
  eventTypes?: Array<AiDmWakePayload["type"]>;
  /** Every token that moved in this wake. */
  tokenIds?: string[];
  /** Ids of every chat message folded into this wake, oldest first. */
  messageIds?: string[];
  /** The chat messages folded into this wake, oldest first. */
  chatMessages?: WakeChatMessage[];
}

export interface WakeChatMessage {
  messageId: string;
  userId: string | null;
  userName: string | null;
  sceneId: string | null;
  timestamp: string;
  content: string;
}

export interface WakeEnrichment {
  worldId: string | null;
  actorId: string | null;
  userName: string | null;
}

export const emptyWakeEnrichment: WakeEnrichment = {
  worldId: null,
  actorId: null,
  userName: null,
};

export interface WakeEnrichmentInput {
  userId: string;
  sceneId: string;
  tokenId: string;
  signal: AbortSignal;
}

export type WakeEnricher = (input: WakeEnrichmentInput) => Promise<WakeEnrichment>;
export type WakePoster = (
  payload: AiDmWakePayload,
  signal: AbortSignal,
) => Promise<HostDeliveryResult>;

export interface WakeDispatchResult extends DeliveryRunResult {
  filtered: number;
  postedGroups: number;
}

export interface WakeObserverMetadata {
  userId: string;
  lane: string;
}

const PATH_LIMIT = 256;

export function isPlayerMovement(event: SequencedMovementEvent): boolean {
  const reporter = event.provenance?.reporterUserId;
  if (!reporter) return false;
  return event.userId !== reporter;
}

export function hasRoomCrossing(events: readonly SequencedMovementEvent[]): boolean {
  return events.some((event) =>
    event.transitions.some((transition) => transition.category === "room"),
  );
}

export function mergeMovementPath(events: readonly SequencedMovementEvent[]): WakePoint[] {
  const path: WakePoint[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    for (const waypoint of event.waypoints) {
      const point = wakePoint(waypoint);
      if (!point) continue;
      const previous = path.at(-1);
      if (previous && samePoint(previous, point)) continue;
      path.push(point);
    }
  }
  return capPath(path);
}

export function buildMovementWakePayload(input: {
  request: HostDeliveryRequest;
  events: readonly SequencedMovementEvent[];
  enrichment: WakeEnrichment;
}): AiDmWakePayload {
  const ordered = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const latest = ordered.at(-1) ?? input.request.event;
  const path = mergeMovementPath(ordered);
  return {
    type: "token_movement",
    worldId: input.enrichment.worldId,
    sceneId: latest.sceneId,
    tokenId: latest.tokenId,
    actorId: input.enrichment.actorId,
    userId: latest.userId,
    userName: input.enrichment.userName,
    from: wakePoint(ordered[0]?.from) ?? path[0] ?? null,
    to: wakePoint(latest.to) ?? path.at(-1) ?? null,
    path,
    sequence: latest.sequence,
    cursor: input.request.eventCursor,
    timestamp: isoTimestamp(latest.timestamp),
    deliveryId: input.request.deliveryId,
    eventId: latest.eventId,
    attempt: input.request.attempt,
    coalescedEventIds: ordered.map((event) => event.eventId).slice(0, 64),
  };
}

export class WakeWebhookAdapter implements HostWakeAdapter {
  readonly capability = "wake" as const;

  constructor(
    private readonly config: WakeWebhookConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly enrich: WakeEnricher = () => Promise.resolve(emptyWakeEnrichment),
  ) {}

  deliver(request: HostDeliveryRequest, signal: AbortSignal): Promise<HostDeliveryResult> {
    return deliverMovementEvents(
      this.config,
      this.fetchImpl,
      this.enrich,
      request,
      [request.event],
      signal,
    );
  }
}

export const UNAVAILABLE_WAKE_MESSAGE =
  "This process has no configured mechanism that can invoke or wake the active Codex AI-GM without a human turn.";

export function selectWakeAdapter(
  environment: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
  enrich?: WakeEnricher,
): { adapter: HostWakeAdapter; config: WakeWebhookConfig } {
  const config = loadWakeWebhookConfig(environment);
  if (!config.enabled)
    return {
      adapter: new UnavailableHostWakeAdapter(config.problem ?? UNAVAILABLE_WAKE_MESSAGE),
      config,
    };
  return {
    adapter: new WakeWebhookAdapter(config, fetchImpl, enrich),
    config,
  };
}

export async function dispatchCoalescedWake(
  service: AiGmDeliveryService,
  config: WakeWebhookConfig,
  fetchImpl: typeof fetch,
  enrich: WakeEnricher = () => Promise.resolve(emptyWakeEnrichment),
): Promise<WakeDispatchResult> {
  const now = service.currentTime();
  const groups = new Map<string, ReturnType<AiGmDeliveryService["list"]>>();
  for (const item of service.list(["queued", "retry_wait"])) {
    const key = `${item.event.sceneId}\0${item.event.tokenId}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const result: WakeDispatchResult = {
    attempted: 0,
    acknowledged: 0,
    retryScheduled: 0,
    deadLettered: 0,
    filtered: 0,
    postedGroups: 0,
  };
  let posts = 0;
  for (const group of groups.values()) {
    group.sort((left, right) => left.eventSequence - right.eventSequence);
    const newest = group.reduce((max, item) => Math.max(max, item.event.timestamp), 0);
    const readyAt = newest + config.debounceMs;
    if (readyAt > now) {
      service.deferUntil(
        group.map((item) => item.id),
        readyAt,
      );
      continue;
    }
    if (!group.every((item) => (item.nextAttemptAt ?? 0) <= now)) continue;
    const events = group.map((item) => item.event);
    const reason = movementFilterReason(events, config);
    if (reason) {
      for (const item of group) {
        service.acknowledge(item.id, `filtered:${reason}`);
        result.filtered += 1;
      }
      continue;
    }
    if (posts >= 25) break;
    const representative = group.at(-1)!;
    const outcome = await service.dispatchDue(
      {
        capability: "wake",
        deliver: (request, signal) =>
          deliverMovementEvents(config, fetchImpl, enrich, request, events, signal),
      },
      1,
      new Set([representative.id]),
    );
    posts += outcome.attempted;
    result.attempted += outcome.attempted;
    result.acknowledged += outcome.acknowledged;
    result.retryScheduled += outcome.retryScheduled;
    result.deadLettered += outcome.deadLettered;
    if (service.get(representative.id)?.state === "acknowledged") {
      result.postedGroups += 1;
      for (const item of group) {
        if (item.id === representative.id) continue;
        try {
          service.acknowledge(item.id, `coalesced-into:${representative.id}`);
        } catch {
          /* The posted item is already durable. A later tick can only retry leftovers. */
        }
      }
    }
  }
  return result;
}

export async function postWakeWebhook(
  config: WakeWebhookConfig,
  payload: AiDmWakePayload,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<HostDeliveryResult> {
  if (!config.enabled || !config.url)
    return {
      status: "rejected",
      code: "WAKE_WEBHOOK_DISABLED",
      message: config.problem ?? "Wake webhook is not configured.",
      retryable: false,
    };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "foundry-ai-dungeon-master-wake/0.1",
  };
  const credential = wakeCredentialHeader(config);
  if (credential) headers[credential.name] = credential.value;
  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal,
    });
  } catch (error) {
    const aborted = signal.aborted || (error instanceof Error && error.name === "AbortError");
    return {
      status: "rejected",
      code: aborted ? "HOST_INVOCATION_TIMEOUT" : "WAKE_WEBHOOK_UNREACHABLE",
      message: aborted ? "Wake webhook aborted before a response." : "Wake webhook request failed.",
      retryable: true,
    };
  }
  if (response.status >= 200 && response.status < 300) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "acknowledged", acknowledgementId: `webhook:${response.status}` };
  }
  const detail = redact(await readLimited(response), config.secret);
  const retryable =
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500;
  return {
    status: "rejected",
    code: `WAKE_HTTP_${response.status}`,
    message: detail || `Wake webhook returned HTTP ${response.status}.`,
    retryable,
  };
}

export function chatWakeFromHook(
  payload: unknown,
  metadata: WakeObserverMetadata,
  now: number,
  playersOnly: boolean,
): AiDmWakePayload | undefined {
  if (metadata.lane !== "gm") return undefined;
  const args = hookArgs(payload);
  const message = asRecord(args[0]);
  if (!message) return undefined;
  // Foundry v12+ stores the author as `author`; older data used `user`.
  const author = documentId(message["author"]) ?? documentId(message["user"]) ?? lastString(args);
  if (playersOnly && author && author === metadata.userId) return undefined;
  const messageId = text(message["_id"]) ?? text(message["id"]);
  const content = plainText(typeof message["content"] === "string" ? message["content"] : "");
  if (!messageId || !content) return undefined;
  const speaker = asRecord(message["speaker"]);
  const timestamp = finite(message["timestamp"]) ?? now;
  return {
    type: "chat_message",
    worldId: null,
    sceneId: text(speaker?.["scene"]),
    tokenId: text(speaker?.["token"]),
    actorId: text(speaker?.["actor"]),
    userId: author ?? null,
    userName: text(speaker?.["alias"]),
    from: null,
    to: null,
    path: [],
    sequence: null,
    cursor: null,
    timestamp: isoTimestamp(timestamp),
    deliveryId: `chat:${messageId}`,
    eventId: `chat:${messageId}`,
    attempt: 1,
    coalescedEventIds: [`chat:${messageId}`],
    messageId,
    content,
  };
}

export function combatWakeFromEvent(
  payload: unknown,
  metadata: WakeObserverMetadata,
  now: number,
): AiDmWakePayload | undefined {
  if (metadata.lane !== "gm") return undefined;
  const record = asRecord(payload);
  if (!record) return undefined;
  const combatId = text(record["combatId"]);
  const round = finite(record["round"]);
  const turn = finite(record["turn"]);
  if (!combatId || round === undefined || turn === undefined) return undefined;
  const eventId = `combat:${combatId}:${round}:${turn}`;
  const timestamp = finite(record["timestamp"]) ?? now;
  const combatantId = text(record["combatantId"]);
  return {
    type: "combat_turn",
    worldId: null,
    sceneId: text(record["sceneId"]),
    tokenId: text(record["tokenId"]),
    actorId: text(record["actorId"]),
    userId: text(record["userId"]),
    userName: text(record["userName"]),
    from: null,
    to: null,
    path: [],
    sequence: null,
    cursor: null,
    timestamp: isoTimestamp(timestamp),
    deliveryId: eventId,
    eventId,
    attempt: 1,
    coalescedEventIds: [eventId],
    combatId,
    round,
    turn,
    ...(combatantId ? { combatantId } : {}),
  };
}

interface AuxiliaryWakeItem {
  payload: AiDmWakePayload;
  attempts: number;
  nextAttemptAt: number;
  receivedAt: number;
}

export class AuxiliaryWakeQueue {
  private readonly items: AuxiliaryWakeItem[] = [];
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxItems = 32,
    private readonly dedupeMs = 60_000,
    readonly maxAttempts = 5,
  ) {}

  get pending(): number {
    return this.items.length;
  }

  push(payload: AiDmWakePayload, now: number): boolean {
    this.expire(now);
    if (this.seen.has(payload.eventId)) return false;
    if (this.items.length >= this.maxItems) this.items.shift();
    this.seen.set(payload.eventId, now + this.dedupeMs);
    this.items.push({ payload, attempts: 0, nextAttemptAt: now, receivedAt: now });
    return true;
  }

  /** Pending items, oldest first. Copies; use the methods below to change state. */
  snapshot(): Array<Readonly<AuxiliaryWakeItem>> {
    return this.items.map((item) => ({ ...item }));
  }

  /** Drop delivered (or abandoned) items by event id. */
  complete(eventIds: Iterable<string>): void {
    const done = new Set(eventIds);
    for (let index = this.items.length - 1; index >= 0; index -= 1)
      if (done.has(this.items[index]!.payload.eventId)) this.items.splice(index, 1);
  }

  /**
   * Count one failed batch attempt for these items and schedule the retry.
   * Items that used every attempt are dropped. Returns the dropped ids.
   */
  fail(eventIds: Iterable<string>, now: number, retryBaseMs = 1_000, retryMaxMs = 60_000): string[] {
    const wanted = new Set(eventIds);
    const dropped: string[] = [];
    for (const item of this.items) {
      if (!wanted.has(item.payload.eventId)) continue;
      item.attempts += 1;
      item.nextAttemptAt =
        now + Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, item.attempts - 1));
      if (item.attempts >= this.maxAttempts) dropped.push(item.payload.eventId);
    }
    this.complete(dropped);
    return dropped;
  }

  /** Posts each due item separately. Batched delivery uses {@link dispatchBatchedWake}. */
  async dispatch(
    poster: WakePoster,
    now: number,
    retryBaseMs = 1_000,
    retryMaxMs = 60_000,
  ): Promise<void> {
    const due = this.items.filter((item) => item.nextAttemptAt <= now).slice(0, 10);
    for (const item of due) {
      item.attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      let result: HostDeliveryResult;
      try {
        result = await poster({ ...item.payload, attempt: item.attempts }, controller.signal);
      } catch {
        result = {
          status: "rejected",
          code: "WAKE_WEBHOOK_UNREACHABLE",
          message: "Wake webhook request failed.",
          retryable: true,
        };
      } finally {
        clearTimeout(timer);
      }
      const done =
        result.status === "acknowledged" ||
        (result.status === "rejected" && !result.retryable) ||
        item.attempts >= this.maxAttempts;
      if (done) {
        const index = this.items.indexOf(item);
        if (index >= 0) this.items.splice(index, 1);
      } else {
        item.nextAttemptAt =
          now + Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, item.attempts - 1));
      }
    }
  }

  private expire(now: number): void {
    for (const [id, until] of this.seen) if (until <= now) this.seen.delete(id);
  }
}

export interface BatchedWakeResult extends WakeDispatchResult {
  /** True while a burst is being held for its quiet period. */
  waiting: boolean;
  /** Chat or combat events delivered in a posted wake. */
  auxiliaryDelivered: number;
}

/**
 * Posts at most ONE webhook per call, covering every pending qualifying event:
 * movement of any token plus queued chat/combat events. A burst is held until
 * `debounceMs` passes with no new qualifying event, capped at `maxWaitMs` after
 * the oldest one, so a run of quick drags or messages wakes the AI-GM once.
 */
export async function dispatchBatchedWake(
  service: AiGmDeliveryService,
  config: WakeWebhookConfig,
  fetchImpl: typeof fetch,
  enrich: WakeEnricher = () => Promise.resolve(emptyWakeEnrichment),
  auxiliary?: AuxiliaryWakeQueue,
  now: number = service.currentTime(),
): Promise<BatchedWakeResult> {
  const result: BatchedWakeResult = {
    attempted: 0,
    acknowledged: 0,
    retryScheduled: 0,
    deadLettered: 0,
    filtered: 0,
    postedGroups: 0,
    waiting: false,
    auxiliaryDelivered: 0,
  };
  // Filters keep their per-token meaning; filtered moves never reach the webhook.
  const groups = new Map<string, ReturnType<AiGmDeliveryService["list"]>>();
  for (const item of service.list(["queued", "retry_wait"])) {
    const key = `${item.event.sceneId}\0${item.event.tokenId}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const movement: ReturnType<AiGmDeliveryService["list"]> = [];
  for (const group of groups.values()) {
    const reason = movementFilterReason(
      group.map((item) => item.event),
      config,
    );
    if (!reason) {
      movement.push(...group);
      continue;
    }
    for (const item of group) {
      service.acknowledge(item.id, `filtered:${reason}`);
      result.filtered += 1;
    }
  }
  movement.sort(
    (left, right) =>
      left.event.timestamp - right.event.timestamp || left.eventSequence - right.eventSequence,
  );
  const extra = auxiliary?.snapshot() ?? [];
  if (movement.length === 0 && extra.length === 0) return result;

  // Clamp client clocks that run ahead so a skewed timestamp cannot stall delivery.
  const arrivals = [
    ...movement.map((item) => Math.min(item.event.timestamp, now)),
    ...extra.map((item) => item.receivedAt),
  ];
  const newest = Math.max(...arrivals);
  const oldest = Math.min(...arrivals);
  const readyAt = Math.min(newest + config.debounceMs, oldest + config.maxWaitMs);
  const retryAt = Math.max(
    0,
    ...movement.map((item) => item.nextAttemptAt ?? 0),
    ...extra.map((item) => item.nextAttemptAt),
  );
  const sendAt = Math.max(readyAt, retryAt);
  if (sendAt > now) {
    service.deferUntil(
      movement.map((item) => item.id),
      sendAt,
    );
    result.waiting = true;
    return result;
  }

  const extraPayloads = extra.map((item) => item.payload);
  const extraIds = extraPayloads.map((payload) => payload.eventId);
  if (movement.length === 0) {
    const attempt = Math.max(...extra.map((item) => item.attempts)) + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let outcome: HostDeliveryResult;
    try {
      const latest = extraPayloads.at(-1)!;
      const enrichment = await enrichQuietly(enrich, latest, controller.signal);
      outcome = await postWakeWebhook(
        config,
        buildBatchWakePayload({ movement: [], extra: extraPayloads, enrichment, attempt }),
        controller.signal,
        fetchImpl,
      );
    } catch {
      outcome = {
        status: "rejected",
        code: "WAKE_WEBHOOK_UNREACHABLE",
        message: "Wake webhook request failed.",
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
    result.attempted = 1;
    if (outcome.status === "acknowledged" || !outcome.retryable) {
      auxiliary!.complete(extraIds);
      if (outcome.status === "acknowledged") {
        result.acknowledged = 1;
        result.postedGroups = 1;
        result.auxiliaryDelivered = extraIds.length;
      } else result.deadLettered = 1;
    } else {
      auxiliary!.fail(extraIds, now);
      result.retryScheduled = 1;
    }
    return result;
  }

  const representative = movement.at(-1)!;
  const events = movement.map((item) => item.event);
  const outcome = await service.dispatchDue(
    {
      capability: "wake",
      deliver: async (request, signal) => {
        const latest = events.at(-1) ?? request.event;
        let enrichment = emptyWakeEnrichment;
        try {
          enrichment = await enrich({
            userId: latest.userId,
            sceneId: latest.sceneId,
            tokenId: latest.tokenId,
            signal,
          });
        } catch (error) {
          if (signal.aborted || (error instanceof Error && error.name === "AbortError"))
            throw error;
        }
        return postWakeWebhook(
          config,
          buildBatchWakePayload({
            request,
            movement: events,
            extra: extraPayloads,
            enrichment,
            attempt: request.attempt,
          }),
          signal,
          fetchImpl,
        );
      },
    },
    1,
    new Set([representative.id]),
  );
  result.attempted += outcome.attempted;
  result.acknowledged += outcome.acknowledged;
  result.retryScheduled += outcome.retryScheduled;
  result.deadLettered += outcome.deadLettered;
  const state = service.get(representative.id)?.state;
  if (state === "acknowledged") {
    result.postedGroups = 1;
    result.auxiliaryDelivered = extraIds.length;
    auxiliary?.complete(extraIds);
    for (const item of movement) {
      if (item.id === representative.id) continue;
      try {
        service.acknowledge(item.id, `coalesced-into:${representative.id}`);
      } catch {
        /* The posted item is already durable. A later tick can only retry leftovers. */
      }
    }
  } else if (state === "dead_letter") {
    // The endpoint refused this wake outright. Do not resend the same chat forever.
    auxiliary?.complete(extraIds);
  } else if (outcome.attempted > 0) {
    auxiliary?.fail(extraIds, now);
  }
  return result;
}

/** One payload for a whole burst. The newest event decides `type` and its headline fields. */
export function buildBatchWakePayload(input: {
  request?: HostDeliveryRequest;
  movement: readonly SequencedMovementEvent[];
  extra: readonly AiDmWakePayload[];
  enrichment: WakeEnrichment;
  attempt: number;
}): AiDmWakePayload {
  const timeline: Array<{ at: number; id: string; type: AiDmWakePayload["type"] }> = [
    ...input.movement.map((event) => ({
      at: event.timestamp,
      id: event.eventId,
      type: "token_movement" as const,
    })),
    ...input.extra.map((payload) => ({
      at: Date.parse(payload.timestamp),
      id: payload.eventId,
      type: payload.type,
    })),
  ].sort((left, right) => left.at - right.at);
  const chats = input.extra.filter((payload) => payload.type === "chat_message");
  const latestExtra = input.extra.at(-1);
  const latestMove = input.movement.at(-1);
  const extraIsNewest =
    latestExtra !== undefined &&
    (!latestMove || Date.parse(latestExtra.timestamp) >= latestMove.timestamp);

  let payload: AiDmWakePayload;
  if (input.request && latestMove) {
    // Path fields describe the most recently moved token only.
    const sameToken = input.movement.filter(
      (event) => event.sceneId === latestMove.sceneId && event.tokenId === latestMove.tokenId,
    );
    payload = buildMovementWakePayload({
      request: input.request,
      events: sameToken,
      enrichment: input.enrichment,
    });
  } else {
    const latest = latestExtra!;
    payload = {
      ...latest,
      worldId: latest.worldId ?? input.enrichment.worldId,
      userName: latest.userName ?? input.enrichment.userName,
      actorId: latest.actorId ?? input.enrichment.actorId,
    };
  }
  if (extraIsNewest && payload.type === "token_movement") {
    const latest = latestExtra;
    payload = {
      ...payload,
      type: latest.type,
      sceneId: latest.sceneId ?? payload.sceneId,
      userId: latest.userId,
      userName: latest.userName,
      timestamp: latest.timestamp,
      eventId: latest.eventId,
      ...(latest.messageId ? { messageId: latest.messageId } : {}),
      ...(latest.content ? { content: latest.content } : {}),
      ...(latest.combatId ? { combatId: latest.combatId } : {}),
      ...(latest.round !== undefined ? { round: latest.round } : {}),
      ...(latest.turn !== undefined ? { turn: latest.turn } : {}),
      ...(latest.combatantId ? { combatantId: latest.combatantId } : {}),
    };
  }
  const latestChat = chats.at(-1);
  if (latestChat && !payload.messageId) {
    payload = {
      ...payload,
      messageId: latestChat.messageId!,
      ...(latestChat.content ? { content: latestChat.content } : {}),
    };
  }
  const tokenIds = [...new Set(input.movement.map((event) => event.tokenId))];
  return {
    ...payload,
    attempt: input.attempt,
    coalescedEventIds: timeline.map((entry) => entry.id).slice(-64),
    eventTypes: [...new Set(timeline.map((entry) => entry.type))],
    ...(tokenIds.length ? { tokenIds } : {}),
    ...(chats.length
      ? {
          messageIds: chats.map((chat) => chat.messageId!).slice(-64),
          chatMessages: chats.slice(-20).map((chat) => ({
            messageId: chat.messageId!,
            userId: chat.userId,
            userName: chat.userName,
            sceneId: chat.sceneId,
            timestamp: chat.timestamp,
            content: chat.content ?? "",
          })),
        }
      : {}),
  };
}

async function enrichQuietly(
  enrich: WakeEnricher,
  payload: AiDmWakePayload,
  signal: AbortSignal,
): Promise<WakeEnrichment> {
  try {
    return await enrich({
      userId: payload.userId ?? "",
      sceneId: payload.sceneId ?? "",
      tokenId: payload.tokenId ?? "",
      signal,
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return emptyWakeEnrichment;
  }
}

export interface WakeBridgeReader {
  getClient(selector?: {
    lane?: "gm" | "player" | "tv";
  }): { clientId: string; userId: string } | null;
  getVerifiedFoundryIdentity(selector: {
    clientId?: string;
    userId?: string;
    lane?: "gm";
  }): { worldId: string } | null;
  call(
    command: string,
    payload: unknown,
    selector: { clientId?: string; userId?: string; lane?: "gm" },
  ): Promise<unknown>;
}

export function createBridgeEnricher(bridge: WakeBridgeReader): WakeEnricher {
  return async (input) => {
    if (input.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const client = bridge.getClient({ lane: "gm" });
    const selector = client
      ? { clientId: client.clientId, userId: client.userId, lane: "gm" as const }
      : { lane: "gm" as const };
    let worldId: string | null = null;
    try {
      worldId = bridge.getVerifiedFoundryIdentity(selector)?.worldId ?? null;
    } catch {
      worldId = null;
    }
    if (!worldId) {
      try {
        const status = await bridge.call("status", {}, selector);
        const candidate = asRecord(status)?.["worldId"];
        if (typeof candidate === "string") worldId = candidate.slice(0, 128);
      } catch {
        worldId = null;
      }
    }
    let userName: string | null = null;
    let actorId: string | null = null;
    try {
      const user = asRecord(await bridge.call("userGet", { userId: input.userId }, selector));
      if (typeof user?.["name"] === "string") userName = user["name"].slice(0, 200);
    } catch {
      userName = null;
    }
    try {
      const token = await bridge.call(
        "sceneGetToken",
        { sceneId: input.sceneId, tokenId: input.tokenId },
        selector,
      );
      actorId = readActorId(token);
    } catch {
      actorId = null;
    }
    if (input.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return { worldId, userName, actorId };
  };
}

async function deliverMovementEvents(
  config: WakeWebhookConfig,
  fetchImpl: typeof fetch,
  enrich: WakeEnricher,
  request: HostDeliveryRequest,
  events: readonly SequencedMovementEvent[],
  signal: AbortSignal,
): Promise<HostDeliveryResult> {
  const latest = events.at(-1) ?? request.event;
  let enrichment = emptyWakeEnrichment;
  try {
    enrichment = await enrich({
      userId: latest.userId,
      sceneId: latest.sceneId,
      tokenId: latest.tokenId,
      signal,
    });
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
  }
  return postWakeWebhook(
    config,
    buildMovementWakePayload({ request, events, enrichment }),
    signal,
    fetchImpl,
  );
}

function movementFilterReason(
  events: readonly SequencedMovementEvent[],
  config: WakeWebhookConfig,
): "players-only" | "no-room-crossing" | undefined {
  if (config.playersOnly && events.some((event) => !isPlayerMovement(event))) return "players-only";
  if (config.roomCrossingsOnly && !hasRoomCrossing(events)) return "no-room-crossing";
  return undefined;
}

function wakePoint(
  point: { x: number; y: number; elevation?: number } | undefined,
): WakePoint | null {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return {
    x: point.x,
    y: point.y,
    ...(typeof point.elevation === "number" && Number.isFinite(point.elevation)
      ? { elevation: point.elevation }
      : {}),
  };
}

function samePoint(left: WakePoint, right: WakePoint): boolean {
  return left.x === right.x && left.y === right.y && left.elevation === right.elevation;
}

function capPath(path: WakePoint[]): WakePoint[] {
  if (path.length <= PATH_LIMIT) return path;
  const last = path.length - 1;
  const kept = new Set<number>([0, last]);
  const slots = PATH_LIMIT - 2;
  for (let index = 1; index <= slots; index += 1)
    kept.add(Math.round((index * last) / (slots + 1)));
  return [...kept].sort((left, right) => left - right).map((index) => path[index]!);
}

function isoTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function hookArgs(payload: unknown): unknown[] {
  if (!Array.isArray(payload)) return [payload];
  const args: unknown[] = [];
  for (const value of payload) args.push(value);
  return args;
}

function documentId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  const id = record?.["_id"] ?? record?.["id"];
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function lastString(values: readonly unknown[]): string | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function readActorId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record["actorId"] === "string" && record["actorId"].trim())
    return record["actorId"].trim().slice(0, 128);
  const actor = asRecord(record["actor"]);
  return typeof actor?.["id"] === "string" && actor["id"].trim()
    ? actor["id"].trim().slice(0, 128)
    : null;
}

async function readLimited(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

function redact(value: string, secret: string | null): string {
  const cleaned = value.replace(/[\r\n\t]+/g, " ").trim();
  const hidden = secret && secret.length >= 4 ? cleaned.split(secret).join("[redacted]") : cleaned;
  return hidden.slice(0, 300);
}
