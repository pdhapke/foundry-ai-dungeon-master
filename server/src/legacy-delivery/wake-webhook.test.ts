import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  buildMovementEvent,
  type MovementRegion,
  type SequencedMovementEvent,
} from "../../../../foundry-local-api/shared/dist/index.js";
import { AiGmDeliveryService } from "./ai-gm-delivery.js";
import { getAiGmDeliveryHealth } from "./endpoints.js";
import { registerLegacyDelivery } from "./extension.js";
import type { LegacyDeliveryContext } from "./api-contract.js";
import { loadWakeWebhookConfig } from "./wake-webhook-config.js";
import {
  AuxiliaryWakeQueue,
  UNAVAILABLE_WAKE_MESSAGE,
  chatWakeFromHook,
  combatWakeFromEvent,
  dispatchCoalescedWake,
  postWakeWebhook,
  selectWakeAdapter,
  type AiDmWakePayload,
} from "./wake-webhook.js";

const room: MovementRegion = {
  id: "hall",
  name: "Hall",
  category: "room",
  polygons: [
    [
      { x: 5, y: -10 },
      { x: 15, y: -10 },
      { x: 15, y: 10 },
      { x: 5, y: 10 },
    ],
  ],
};

function movement(input: {
  eventId: string;
  sequence: number;
  tokenId?: string;
  userId?: string;
  reporterUserId?: string;
  timestamp: number;
  waypoints: Array<{ x: number; y: number; elevation?: number }>;
  regions?: MovementRegion[];
}): SequencedMovementEvent {
  const built = buildMovementEvent({
    eventId: input.eventId,
    sceneId: "scene-1",
    tokenId: input.tokenId ?? "token-1",
    userId: input.userId ?? "player-1",
    timestamp: input.timestamp,
    waypoints: input.waypoints,
    regions: input.regions ?? [],
  });
  return {
    ...built,
    sequence: input.sequence,
    provenance: {
      reporterClientId: "gm-client",
      reporterUserId: input.reporterUserId ?? "gm-user",
      reporterLane: "gm",
    },
  };
}

function queue(now: () => number): { service: AiGmDeliveryService; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "wake-webhook-"));
  return {
    directory,
    service: new AiGmDeliveryService(join(directory, "delivery.json"), "codex-active-ai-gm", {
      now,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 1_000,
      attemptTimeoutMs: 5_000,
    }),
  };
}

function recorder(status = 204): {
  fetch: typeof fetch;
  bodies: AiDmWakePayload[];
  headers: Array<Record<string, string>>;
  redirects: Array<RequestInit["redirect"]>;
} {
  const bodies: AiDmWakePayload[] = [];
  const headers: Array<Record<string, string>> = [];
  const redirects: Array<RequestInit["redirect"]> = [];
  const fetchImpl: typeof fetch = (_url, init) => {
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    redirects.push(init?.redirect);
    if (typeof init?.body !== "string") throw new Error("Wake test expected a string body.");
    bodies.push(JSON.parse(init.body) as AiDmWakePayload);
    return Promise.resolve(new Response(status === 500 ? "nope secret-value" : null, { status }));
  };
  return { fetch: fetchImpl, bodies, headers, redirects };
}

const baseEnv = {
  AI_DM_WAKE_WEBHOOK_URL: "https://dm.example.test/wake",
  AI_DM_WAKE_WEBHOOK_SECRET: "secret-value",
};

void test("wake webhook stays off until a URL is configured", () => {
  assert.equal(loadWakeWebhookConfig({}).enabled, false);
  const selected = selectWakeAdapter({});
  assert.equal(selected.adapter.capability, "unavailable");
  assert.equal(selected.adapter.limitation, UNAVAILABLE_WAKE_MESSAGE);
  const invalid = loadWakeWebhookConfig({ AI_DM_WAKE_WEBHOOK_URL: "ftp://files.example/hook" });
  assert.equal(invalid.enabled, false);
  assert.match(invalid.problem ?? "", /http or https/);
  assert.equal(
    loadWakeWebhookConfig({
      ...baseEnv,
      AI_DM_WAKE_WEBHOOK_SECRET: "line\nbreak",
    }).enabled,
    false,
  );
});

void test("default credential header is Authorization Bearer and the secret stays out of the body", async () => {
  const config = loadWakeWebhookConfig(baseEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.headerName, "Authorization");
  assert.equal(config.scheme, "Bearer");
  assert.equal(config.playersOnly, true);
  assert.equal(config.debounceMs, 4_000);
  assert.equal(config.chat, false);
  assert.equal(config.combatTurns, false);
  const captured = recorder();
  const result = await postWakeWebhook(
    config,
    {
      type: "token_movement",
      worldId: "world",
      sceneId: "scene-1",
      tokenId: "token-1",
      actorId: "actor-1",
      userId: "player-1",
      userName: "Izzy",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 0 },
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      sequence: 1,
      cursor: "gen:1",
      timestamp: "2026-10-31T00:00:00.000Z",
      deliveryId: "delivery-1",
      eventId: "move-1",
      attempt: 1,
      coalescedEventIds: ["move-1"],
    },
    new AbortController().signal,
    captured.fetch,
  );
  assert.equal(result.status, "acknowledged");
  if (result.status === "acknowledged") assert.equal(result.acknowledgementId, "webhook:204");
  assert.equal(captured.headers[0]?.["authorization"], "Bearer secret-value");
  assert.equal(captured.redirects[0], "error");
  assert.equal(JSON.stringify(captured.bodies).includes("secret-value"), false);
});

void test("an arbitrary header can carry the raw secret", async () => {
  const config = loadWakeWebhookConfig({
    ...baseEnv,
    AI_DM_WAKE_WEBHOOK_HEADER: "X-Api-Key",
    AI_DM_WAKE_WEBHOOK_SCHEME: "",
  });
  const captured = recorder();
  await postWakeWebhook(
    config,
    {
      type: "chat_message",
      worldId: null,
      sceneId: null,
      tokenId: null,
      actorId: null,
      userId: "player-1",
      userName: null,
      from: null,
      to: null,
      path: [],
      sequence: null,
      cursor: null,
      timestamp: "2026-10-31T00:00:00.000Z",
      deliveryId: "chat:1",
      eventId: "chat:1",
      attempt: 1,
      coalescedEventIds: ["chat:1"],
      messageId: "1",
      content: "hello",
    },
    new AbortController().signal,
    captured.fetch,
  );
  assert.equal(captured.headers[0]?.["x-api-key"], "secret-value");
  assert.equal(captured.headers[0]?.["authorization"], undefined);
});

void test("a token drag inside the debounce window is one acknowledged delivery", async (t) => {
  let now = 2_500;
  const { service, directory } = queue(() => now);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  service.enqueue(
    movement({
      eventId: "drag-1",
      sequence: 1,
      timestamp: 1_000,
      waypoints: [
        { x: 0, y: 0, elevation: 0 },
        { x: 10, y: 0, elevation: 0 },
      ],
    }),
    "gen:1",
  );
  service.enqueue(
    movement({
      eventId: "drag-2",
      sequence: 2,
      timestamp: 2_000,
      waypoints: [
        { x: 10, y: 0, elevation: 0 },
        { x: 20, y: 5, elevation: 1 },
      ],
    }),
    "gen:2",
  );
  const config = loadWakeWebhookConfig({ ...baseEnv, AI_DM_WAKE_DEBOUNCE_MS: "4000" });
  const captured = recorder();
  const enrich = () => Promise.resolve({
    worldId: "izzy-campaign",
    actorId: "actor-izzy",
    userName: "Izzy",
  });
  const waiting = await dispatchCoalescedWake(service, config, captured.fetch, enrich);
  assert.equal(waiting.postedGroups, 0);
  assert.equal(captured.bodies.length, 0);
  assert.equal(service.list(["queued"])[0]?.nextAttemptAt, 6_000);

  now = 6_000;
  const posted = await dispatchCoalescedWake(service, config, captured.fetch, enrich);
  assert.equal(posted.postedGroups, 1);
  assert.equal(captured.bodies.length, 1);
  const body = captured.bodies[0]!;
  assert.equal(body.type, "token_movement");
  assert.equal(body.worldId, "izzy-campaign");
  assert.equal(body.actorId, "actor-izzy");
  assert.equal(body.userName, "Izzy");
  assert.equal(body.userId, "player-1");
  assert.equal(body.sceneId, "scene-1");
  assert.equal(body.tokenId, "token-1");
  assert.deepEqual(body.from, { x: 0, y: 0, elevation: 0 });
  assert.deepEqual(body.to, { x: 20, y: 5, elevation: 1 });
  assert.deepEqual(body.path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 10, y: 0, elevation: 0 },
    { x: 20, y: 5, elevation: 1 },
  ]);
  assert.equal(body.sequence, 2);
  assert.equal(body.cursor, "gen:2");
  assert.equal(body.timestamp, new Date(2_000).toISOString());
  assert.deepEqual(body.coalescedEventIds, ["drag-1", "drag-2"]);
  assert.equal(JSON.stringify(body).includes("secret-value"), false);
  assert.equal(
    service.list().every((item) => item.state === "acknowledged"),
    true,
  );
  const sibling = service.list().find((item) => item.eventId === "drag-1");
  assert.equal(
    sibling?.acknowledgementId,
    `coalesced-into:${service.list().find((item) => item.eventId === "drag-2")?.id}`,
  );
});

void test("player-only and room-crossing filters acknowledge without a request", async (t) => {
  const now = 10_000;
  const directories: string[] = [];
  t.after(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
  const first = queue(() => now);
  directories.push(first.directory);
  const service = first.service;
  service.enqueue(
    movement({
      eventId: "gm-drag",
      sequence: 1,
      userId: "gm-user",
      timestamp: 1_000,
      waypoints: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    }),
    "gen:1",
  );
  const players = loadWakeWebhookConfig({ ...baseEnv, AI_DM_WAKE_DEBOUNCE_MS: "0" });
  const captured = recorder();
  const filtered = await dispatchCoalescedWake(service, players, captured.fetch);
  assert.equal(filtered.filtered, 1);
  assert.equal(captured.bodies.length, 0);
  assert.equal(service.list()[0]?.acknowledgementId, "filtered:players-only");

  const second = queue(() => now);
  directories.push(second.directory);
  const crossing = second.service;
  crossing.enqueue(
    movement({
      eventId: "inside",
      sequence: 1,
      timestamp: 1_000,
      waypoints: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    }),
    "gen:1",
  );
  const rooms = loadWakeWebhookConfig({
    ...baseEnv,
    AI_DM_WAKE_DEBOUNCE_MS: "0",
    AI_DM_WAKE_ROOM_CROSSINGS_ONLY: "true",
  });
  const skipped = await dispatchCoalescedWake(crossing, rooms, captured.fetch);
  assert.equal(skipped.filtered, 1);
  assert.equal(crossing.list()[0]?.acknowledgementId, "filtered:no-room-crossing");

  const third = queue(() => now);
  directories.push(third.directory);
  const entered = third.service;
  entered.enqueue(
    movement({
      eventId: "enter-hall",
      sequence: 1,
      timestamp: 1_000,
      waypoints: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      regions: [room],
    }),
    "gen:1",
  );
  const sent = await dispatchCoalescedWake(entered, rooms, captured.fetch);
  assert.equal(sent.postedGroups, 1);
  assert.equal(captured.bodies.at(-1)?.eventId, "enter-hall");
  assert.equal(captured.bodies.length, 1);
});

void test("HTTP 2xx acknowledges and HTTP 500 uses the queue retry", async (t) => {
  let now = 5_000;
  let status = 500;
  const { service, directory } = queue(() => now);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  service.enqueue(
    movement({
      eventId: "retry-me",
      sequence: 1,
      timestamp: 1_000,
      waypoints: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
      ],
    }),
    "gen:1",
  );
  const config = loadWakeWebhookConfig({
    ...baseEnv,
    AI_DM_WAKE_DEBOUNCE_MS: "0",
    AI_DM_WAKE_PLAYERS_ONLY: "false",
  });
  let calls = 0;
  const fetchImpl: typeof fetch = () => {
    calls += 1;
    return Promise.resolve(new Response(status === 204 ? null : "secret-value failed", { status }));
  };
  const first = await dispatchCoalescedWake(service, config, fetchImpl);
  assert.equal(first.retryScheduled, 1);
  assert.equal(service.list()[0]?.state, "retry_wait");
  assert.equal(service.list()[0]?.lastFailure?.code, "WAKE_HTTP_500");
  assert.equal(service.list()[0]?.lastFailure?.message.includes("secret-value"), false);
  now = 5_000;
  assert.equal((await dispatchCoalescedWake(service, config, fetchImpl)).attempted, 0);
  now = 6_000;
  status = 204;
  const second = await dispatchCoalescedWake(service, config, fetchImpl);
  assert.equal(second.acknowledged, 1);
  assert.equal(calls, 2);
  assert.equal(service.list()[0]?.state, "acknowledged");
  assert.equal(service.list()[0]?.acknowledgementId, "webhook:204");
});

void test("HTTP 400 dead-letters instead of retrying", async (t) => {
  const { service, directory } = queue(() => 5_000);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  service.enqueue(
    movement({
      eventId: "bad",
      sequence: 1,
      timestamp: 1_000,
      waypoints: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    }),
    "gen:1",
  );
  const config = loadWakeWebhookConfig({ ...baseEnv, AI_DM_WAKE_DEBOUNCE_MS: "0" });
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response("no", { status: 400 }));
  const result = await dispatchCoalescedWake(service, config, fetchImpl);
  assert.equal(result.deadLettered, 1);
  assert.equal(service.list()[0]?.state, "dead_letter");
  assert.equal(service.list()[0]?.lastFailure?.retryable, false);
});

void test("chat and combat events post through the same webhook and dedupe", async () => {
  const chat = chatWakeFromHook(
    [
      {
        _id: "message-1",
        content: "<p>Look out</p>",
        speaker: { alias: "Izzy" },
        user: "player-1",
      },
    ],
    { userId: "gm-user", lane: "gm" },
    1_700_000_000_000,
    true,
  );
  assert.ok(chat);
  assert.equal(chat.type, "chat_message");
  assert.equal(chat.content, "Look out");
  assert.equal(chat.userName, "Izzy");
  assert.equal(
    chatWakeFromHook(
      [{ _id: "message-2", content: "GM note", user: "gm-user" }],
      { userId: "gm-user", lane: "gm" },
      1,
      true,
    ),
    undefined,
  );
  assert.equal(
    chatWakeFromHook(
      [{ _id: "message-3", content: "from the player client", user: "player-1" }],
      { userId: "player-1", lane: "player" },
      1,
      false,
    ),
    undefined,
  );
  const combat = combatWakeFromEvent(
    {
      combatId: "combat-1",
      sceneId: "scene-1",
      round: 2,
      turn: 0,
      combatantId: "combatant-1",
      tokenId: "token-1",
      actorId: "actor-1",
      userId: "player-1",
      userName: "Izzy",
      timestamp: 1_700_000_000_000,
    },
    { userId: "gm-user", lane: "gm" },
    1,
  );
  assert.ok(combat);
  assert.equal(combat.type, "combat_turn");
  assert.equal(combat.round, 2);
  assert.equal(combat.combatantId, "combatant-1");
  const queue = new AuxiliaryWakeQueue();
  assert.equal(queue.push(chat, 1), true);
  assert.equal(queue.push(chat, 1), false);
  assert.equal(queue.push(combat, 1), true);
  const captured = recorder(503);
  const config = loadWakeWebhookConfig(baseEnv);
  await queue.dispatch(
    (payload, signal) => postWakeWebhook(config, payload, signal, captured.fetch),
    1,
    50,
    50,
  );
  assert.deepEqual(
    captured.bodies.map((body) => body.type).sort(),
    ["chat_message", "combat_turn"],
  );
  assert.equal(queue.pending, 2);
  const ok = recorder(200);
  await queue.dispatch(
    (payload, signal) => postWakeWebhook(config, payload, signal, ok.fetch),
    100,
    50,
    50,
  );
  assert.equal(ok.bodies.length, 2);
  assert.equal(queue.pending, 0);
});

void test("registration uses the webhook when configured and the placeholder otherwise", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wake-registration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let shutdown: (() => Promise<void>) | undefined;
  const context = {
    runtimeRoot: pathToFileURL(`${directory}/`),
    bridge: {
      getClient: () => null,
      getVerifiedFoundryIdentity: () => null,
    },
    call: () => Promise.resolve({}),
    movement: {
      path: join(directory, "movement.json"),
      getStore: () => undefined,
      reloadStore: () => undefined,
      diagnose: () => ({ configured: false }),
      onRecord: () => () => undefined,
    },
    registerEndpoints: () => () => undefined,
    onShutdown: (handler: () => Promise<void>) => {
      shutdown = handler;
      return () => undefined;
    },
    createProtocolError: (body: { message: string }) => new Error(body.message),
  } as unknown as LegacyDeliveryContext;
  try {
    registerLegacyDelivery(context, undefined, {});
    assert.equal(getAiGmDeliveryHealth().hostCapability, "unavailable");
    assert.equal(getAiGmDeliveryHealth().hostLimitation, UNAVAILABLE_WAKE_MESSAGE);
    await shutdown?.();
    registerLegacyDelivery(context, undefined, baseEnv);
    assert.equal(getAiGmDeliveryHealth().hostCapability, "wake");
    assert.equal(getAiGmDeliveryHealth().hostLimitation, undefined);
  } finally {
    await shutdown?.();
  }
});
