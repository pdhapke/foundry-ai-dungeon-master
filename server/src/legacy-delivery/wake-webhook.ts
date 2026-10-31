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
  const author =
    typeof message["user"] === "string" ? message["user"] : lastString(args);
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

export class AuxiliaryWakeQueue {
  private readonly items: Array<{
    payload: AiDmWakePayload;
    attempts: number;
    nextAttemptAt: number;
  }> = [];
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxItems = 32,
    private readonly dedupeMs = 60_000,
    private readonly maxAttempts = 5,
  ) {}

  get pending(): number {
    return this.items.length;
  }

  push(payload: AiDmWakePayload, now: number): boolean {
    this.expire(now);
    if (this.seen.has(payload.eventId)) return false;
    if (this.items.length >= this.maxItems) this.items.shift();
    this.seen.set(payload.eventId, now + this.dedupeMs);
    this.items.push({ payload, attempts: 0, nextAttemptAt: now });
    return true;
  }

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
