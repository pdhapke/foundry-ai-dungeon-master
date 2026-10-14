import assert from "node:assert/strict";
import test from "node:test";
import type { ChatKitTrigger } from "./chatkit-context.js";
import type { CompletedPlayerTurnInput, DmControllerScope } from "./dm-event-adapter.js";
import type { AiDmHookIntegration } from "./hooks.js";

void test("registered physical Region, remote combat, door and cancellation hooks (mocked Foundry API)", async () => {
  const callbacks = new Map<string, (...args: unknown[]) => unknown>();
  const combat = {
    id: "combat",
    scene: "scene",
    active: true,
    round: 1,
    turn: 0,
    turns: [{ id: "player", actor: { hasPlayerOwner: true } }, { id: "npc" }],
    _stats: { modifiedTime: 1 },
  };
  const wall = { id: "door", parent: { id: "scene" }, door: 1, ds: 0, _stats: { modifiedTime: 1 } };
  const models: Record<
    string,
    { events: { tokenEnter: (this: unknown, event: unknown) => void } }
  > = {};
  const notifications: string[] = [];
  const runtimeWorld = { id: "world" };
  const runtimeScene = { id: "scene" };
  Object.assign(globalThis, {
    window: { addEventListener: () => {}, setTimeout, clearTimeout },
    foundry: {
      applications: {
        api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base: unknown) => base },
      },
      data: {
        regionBehaviors: { RegionBehaviorType: class {} },
        fields: { StringField: class {} },
      },
    },
    CONFIG: { RegionBehavior: { dataModels: models } },
    Hooks: {
      on: (name: string, callback: (...args: unknown[]) => unknown) =>
        callbacks.set(name, callback),
    },
    game: {
      user: { id: "gm", isGM: true },
      world: runtimeWorld,
      settings: { get: () => true },
      users: { get: () => ({ id: "gm", isGM: true }) },
      scenes: [{ id: "scene", walls: [wall] }],
      combats: [combat],
      paused: false,
    },
    canvas: {
      scene: runtimeScene,
      tokens: { placeables: [{ document: { actor: { hasPlayerOwner: true } } }] },
    },
    ui: { notifications: { error: () => assert.fail("unexpected trigger failure"), info: (message: string) => notifications.push(message) } },
  });
  const { AiDungeonMasterApplication } = await import("./application.js");
  const { aiDmController } = await import("./controller.js");
  const sent: ChatKitTrigger[] = [];
  AiDungeonMasterApplication.open = () =>
    ({
      trigger: (request: ChatKitTrigger) => {
        sent.push(request);
        return Promise.resolve();
      },
    }) as unknown as InstanceType<typeof AiDungeonMasterApplication>;
  aiDmController.store.setAuthenticated("gm", "fixture");
  const { registerAiDungeonMasterHooks } = await import("./hooks.js");
  const scopeState: { binding: DmControllerScope | undefined } = { binding: undefined };
  let bindingChanged!: () => void;
  let mode = "embedded";
  const dotEvents: CompletedPlayerTurnInput[] = [];
  const integration: AiDmHookIntegration = {
    scope: () => scopeState.binding,
    submit: (input, cancellation) => {
      assert.equal(cancellation.aborted, false);
      dotEvents.push(input);
      return Promise.resolve();
    },
    onChange: (listener) => { bindingChanged = listener; },
  };
  registerAiDungeonMasterHooks(integration);
  callbacks.get("pauseGame")!(false);
  callbacks.get("foundryLocalApiPauseResult")!({ outcome: "uncertain", paused: false, worldId: "world" });
  callbacks.get("foundryLocalApiPauseResult")!({ outcome: "confirmed", paused: false, worldId: "other" });
  assert.deepEqual(notifications, []);
  callbacks.get("foundryLocalApiPauseResult")!({ outcome: "confirmed", paused: false, worldId: "world", correlationId: "aidm-fixture" });
  assert.deepEqual(notifications, ["Unpaused."]);
  assert.equal(sent.length, 0, "Pause observations/receipts never trigger another DM turn");
  callbacks.get("ready")!();
  const enter = models["foundry-ai-dungeon-master.keyedArea"]!.events.tokenEnter;
  const region = { id: "region", parent: { id: "scene" } };
  const event = {
    region,
    user: { id: "gm" },
    data: {
      token: {
        id: "token",
        parent: { id: "scene" },
        actor: { hasPlayerOwner: true },
        _stats: { modifiedTime: 1 },
      },
      movement: { id: "movement" },
    },
  };
  enter.call({ key: "room", region }, event);
  enter.call({ key: "room", region }, event);
  combat.turn = 1;
  combat._stats.modifiedTime = 2;
  callbacks.get("updateCombat")!(combat, { turn: 1 }, {});
  wall.ds = 1;
  wall._stats.modifiedTime = 2;
  callbacks.get("updateWall")!(wall, { ds: 1 }, {}, "gm");
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.deepEqual(sent.map((value) => value.automatic?.kind).sort(), ["area", "door", "turn"]);
  const movedToken = { ...event.data.token, x: 10, y: 20, _stats: { modifiedTime: 10 } };
  const markedMovement = { id: "marked", passed: { waypoints: [{ x: 10, y: 20 }] } };
  const markedOptions = {
    correlationId: "aidm-one",
    foundryLocalApi: { authorizedGmMovement: true },
    foundryLocalApiOrigin: {
      source: "foundry-local-api.session-action",
      phase: "apply",
      correlationId: "aidm-one",
    },
    _movement: { token: markedMovement },
  };
  callbacks.get("preUpdateToken")!(movedToken, { x: 10, y: 20 }, markedOptions);
  callbacks.get("updateToken")!(movedToken, { x: 10, y: 20 }, markedOptions);
  enter.call(
    { key: "ai-room", region },
    { ...event, data: { token: movedToken, movement: markedMovement } },
  );
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.equal(sent.length, 3, "correlated physical Region AI move echo suppressed");
  callbacks.get("preUpdateToken")!(movedToken, { x: 10, y: 20 }, {});
  enter.call(
    { key: "manual-room", region },
    { ...event, data: { token: movedToken, movement: markedMovement } },
  );
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.equal(sent.length, 4, "unmarked manual move invalidates AI evidence");
  sent.pop(); // Keep the original subsequent cancellation assertions scoped to their initial three turns.
  combat.turn = 0;
  combat._stats.modifiedTime = 3;
  callbacks.get("updateCombat")!(combat, { turn: 0 }, {}); // Backward is not completion.
  wall.ds = 0;
  callbacks.get("updateWall")!(wall, { ds: 0 }, {}, "gm");
  wall.ds = 1;
  wall._stats.modifiedTime = 4;
  callbacks.get("updateWall")!(
    wall,
    { ds: 1 },
    {
      foundryLocalApiOrigin: {
        source: "foundry-local-api.transaction",
        phase: "apply",
        correlationId: "aidm-fixture",
      },
    },
    "gm",
  );
  enter.call(
    { key: "room2", region },
    { ...event, data: { ...event.data, movement: { id: "movement2" } } },
  );
  callbacks.get("canvasTearDown")!();
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.equal(sent.length, 3);

  // Queue an embedded turn, then deliberately switch modes before its timer.
  combat.round = 1;
  combat.turn = 0;
  combat._stats.modifiedTime = 20;
  bindingChanged();
  combat.turn = 1;
  combat._stats.modifiedTime = 21;
  callbacks.get("updateCombat")!(combat, { turn: 1 }, {});
  integration.mode = () => mode;
  mode = "dot";
  const binding = { worldId: "world", sessionId: "session", controllerId: "controller", sceneId: "scene", connected: true, isController: true, automaticEventsEnabled: true };
  scopeState.binding = binding;
  bindingChanged();
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.equal(sent.length, 3, "mode switch cancels the pending embedded turn");
  assert.equal(dotEvents.length, 0, "switching never replays an existing turn to dot");

  // Rebaseline on reconnect; completed turn extraction now uses JSON initiative order.
  combat.turn = 0;
  combat._stats.modifiedTime = 22;
  bindingChanged();
  combat.turn = 1;
  combat._stats.modifiedTime = 23;
  callbacks.get("updateCombat")!(combat, { turn: 1 }, {});
  callbacks.get("updateCombat")!(combat, { turn: 1 }, {});
  wall.ds = 0;
  callbacks.get("updateWall")!(wall, { ds: 0 }, {}, "gm");
  wall.ds = 1;
  wall._stats.modifiedTime = 23;
  callbacks.get("updateWall")!(wall, { ds: 1 }, {}, "gm");
  enter.call({ key: "dot-room", region }, { ...event, data: { ...event.data, movement: { id: "dot-movement" } } });
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.equal(dotEvents.length, 1, "one acknowledged dot observation for the completed turn");
  assert.equal(sent.length, 3, "dot mode does not invoke embedded turn, door or keyed area inference");
  assert.equal(dotEvents[0]!.sessionId, "session");
  assert.equal(dotEvents[0]!.controllerId, "controller");
  assert.deepEqual(dotEvents[0]!.previous, { round: 1, turn: 0, combatantId: "player" });
  assert.deepEqual(dotEvents[0]!.next, { round: 1, turn: 1, combatantId: "npc" });

  // Each verified binding lifecycle change cancels any observation still hashing.
  for (const mutate of [
    () => { binding.sessionId = "session-two"; },
    () => { binding.controllerId = "controller-two"; },
    () => { binding.connected = false; },
    () => { binding.isController = false; },
    () => { binding.automaticEventsEnabled = false; },
  ]) {
    combat.turn = 0;
    combat._stats.modifiedTime++;
    binding.connected = true;
    binding.isController = true;
    binding.automaticEventsEnabled = true;
    bindingChanged();
    combat.turn = 1;
    combat._stats.modifiedTime++;
    callbacks.get("updateCombat")!(combat, { turn: 1 }, {});
    mutate();
    bindingChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(dotEvents.length, 1, "stale session/controller/disconnected/observer callbacks never enqueue");

  binding.connected = true;
  binding.isController = true;
  binding.automaticEventsEnabled = true;
  combat.turn = 0;
  combat._stats.modifiedTime++;
  bindingChanged();
  combat.turn = 1;
  combat._stats.modifiedTime++;
  callbacks.get("updateCombat")!(combat, { turn: 1 }, {
    foundryLocalApiOrigin: { source: "foundry-local-api.session-action", phase: "apply", correlationId: "dot-action" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(dotEvents.length, 1, "DM-caused combat updates cannot feed back into dot");

  // Refuse a stale world/scene even before its lifecycle notification arrives.
  for (const runtimeScope of [runtimeWorld, runtimeScene]) {
    combat.turn = 0;
    combat._stats.modifiedTime++;
    bindingChanged();
    combat.turn = 1;
    combat._stats.modifiedTime++;
    callbacks.get("updateCombat")!(combat, { turn: 1 }, {});
    const oldId = runtimeScope.id;
    runtimeScope.id = "other";
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtimeScope.id = oldId;
    bindingChanged();
  }
  assert.equal(dotEvents.length, 1, "world/scene changes refuse observations still hashing");

  // Disconnect and scene/world changes also cancel pending embedded work.
  mode = "embedded";
  for (const eventName of ["disconnect", "canvasTearDown", "canvasReady"]) {
    combat.turn = 0;
    combat._stats.modifiedTime++;
    bindingChanged();
    combat.turn = 1;
    combat._stats.modifiedTime++;
    callbacks.get("updateCombat")!(combat, { turn: 1 }, {});
    callbacks.get(eventName)!();
    await new Promise((resolve) => setTimeout(resolve, 310));
  }
  assert.equal(sent.length, 3, "embedded queued work is cancelled across disconnect and canvas lifecycle");
  for (const runtimeScope of [runtimeWorld, runtimeScene]) {
    combat.turn = 0;
    combat._stats.modifiedTime++;
    bindingChanged();
    combat.turn = 1;
    combat._stats.modifiedTime++;
    callbacks.get("updateCombat")!(combat, { turn: 1 }, {});
    const oldId = runtimeScope.id;
    runtimeScope.id = "other";
    await new Promise((resolve) => setTimeout(resolve, 310));
    runtimeScope.id = oldId;
    bindingChanged();
  }
  assert.equal(sent.length, 3, "timer revalidation cancels embedded work on a world/scene change");
});
