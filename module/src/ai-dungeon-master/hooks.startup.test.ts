import assert from "node:assert/strict";
import test from "node:test";
import type { ChatKitTrigger } from "./chatkit-context.js";

void test("module init tolerates no user, rebaselines at ready, and cancels when the user disappears", async () => {
  const callbacks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const on = (name: string, callback: (...args: unknown[]) => unknown) => {
    const listeners = callbacks.get(name) ?? [];
    listeners.push(callback);
    callbacks.set(name, listeners);
  };
  const emit = (name: string, ...args: unknown[]) => {
    for (const callback of callbacks.get(name) ?? []) callback(...args);
  };
  const settings = new Map<string, { default: unknown; onChange?: () => void }>();
  const values = new Map<string, unknown>();
  const combat = {
    id: "combat",
    scene: "scene",
    active: true,
    round: 1,
    turn: 0,
    turns: [{ id: "player", actor: { hasPlayerOwner: true } }, { id: "npc" }],
    _stats: { modifiedTime: 1 },
  };
  const runtime: {
    user: { id: string; isGM: boolean } | null | undefined;
    world: { id: string } | undefined;
    combats: (typeof combat)[];
  } = { user: null, world: undefined, combats: [] };
  const canvasState: { scene: { id: string } | undefined } = { scene: undefined };
  const bridgeListeners = new Set<() => void>();
  let scopeReads = 0;
  const dot = {
    getScope: () => {
      scopeReads++;
      return {
        worldId: "world",
        sessionId: "session",
        controllerId: "controller",
        sceneId: "scene",
        clientId: "verified-client",
        userId: "gm",
        connected: true,
        isController: true,
        automaticEventsEnabled: true,
      };
    },
    currentState: () => undefined,
    submitCompletedTurn: () => assert.fail("No dot submission in default embedded mode"),
    onLifecycle: (listener: () => void) => {
      bridgeListeners.add(listener);
      return () => {
        bridgeListeners.delete(listener);
      };
    },
  };
  const gameState = Object.assign(runtime, {
    settings: {
      register: (
        _id: string,
        key: string,
        setting: { default: unknown; onChange?: () => void },
      ) => {
        settings.set(key, setting);
      },
      get: (_id: string, key: string) =>
        values.has(key) ? values.get(key) : settings.get(key)?.default,
    },
    modules: new Map([["foundry-ai-dungeon-master", { api: { dot } }]]),
    keybindings: { register: () => {} },
    paused: false,
  });
  Object.assign(globalThis, {
    game: gameState,
    canvas: canvasState,
    Hooks: { on, once: on },
    window: { addEventListener: () => {}, setTimeout, clearTimeout },
    foundry: {
      applications: {
        api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base: unknown) => base },
      },
    },
    ui: {
      notifications: {
        error: () => assert.fail("unexpected error"),
        warn: () => {},
        info: () => {},
      },
    },
  });
  const { aiDmController } = await import("./controller.js");
  let connects = 0;
  aiDmController.connect = () => {
    connects++;
  };
  const { AiDungeonMasterApplication } = await import("./application.js");
  const sent: ChatKitTrigger[] = [];
  AiDungeonMasterApplication.open = () =>
    ({
      trigger: (request: ChatKitTrigger) => {
        sent.push(request);
        return Promise.resolve();
      },
    }) as unknown as InstanceType<typeof AiDungeonMasterApplication>;

  await import("../index.js");
  assert.doesNotThrow(() => emit("init"), "init must not require Foundry's selected user");
  assert.equal(settings.get("dmEventMode")?.default, "embedded");
  assert.equal(settings.get("automaticEventsEnabled")?.default, false);
  assert.equal(scopeReads, 0, "an absent user never consults the dot binding for authority");

  for (const user of [null, undefined, null]) {
    runtime.user = user;
    for (const name of ["canvasReady", "canvasTearDown", "disconnect"]) {
      assert.doesNotThrow(() => emit(name));
    }
    assert.doesNotThrow(() =>
      emit("updateSetting", { key: "foundry-ai-dungeon-master.dmEventMode" }),
    );
    assert.doesNotThrow(() => settings.get("dmEventMode")?.onChange?.());
    for (const listener of bridgeListeners) assert.doesNotThrow(listener);
  }
  assert.equal(scopeReads, 0);
  assert.equal(sent.length, 0);

  runtime.user = { id: "gm", isGM: true };
  runtime.world = { id: "world" };
  runtime.combats = [combat];
  canvasState.scene = { id: "scene" };
  assert.doesNotThrow(() => emit("ready"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(
    connects,
    1,
    "ready connection is a test stub; no service or authentication is started",
  );
  assert.ok(scopeReads > 0, "the selected user can now be checked against the verified binding");
  assert.equal(sent.length, 0, "ready snapshots do not manufacture a completed turn");

  values.set("automaticEventsEnabled", true);
  settings.get("automaticEventsEnabled")?.onChange?.();
  aiDmController.store.setAuthenticated("gm", "fixture");
  combat.turn = 1;
  combat._stats.modifiedTime = 2;
  emit("updateCombat", combat, { turn: 1 }, {});
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.equal(sent.length, 1, "embedded behavior works after the user resolves");
  assert.equal(sent[0]?.automatic?.kind, "turn");

  combat.turn = 0;
  combat._stats.modifiedTime = 3;
  emit("canvasReady");
  combat.turn = 1;
  combat._stats.modifiedTime = 4;
  emit("updateCombat", combat, { turn: 1 }, {});
  runtime.user = null;
  emit("disconnect");
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.equal(sent.length, 1, "user loss cancels the pending embedded turn");
  runtime.user = { id: "gm", isGM: true };
  emit("canvasReady");
  emit("canvasReady");
  emit("updateCombat", combat, { turn: 1 }, {});
  await new Promise((resolve) => setTimeout(resolve, 310));
  assert.equal(sent.length, 1, "repeated lifecycle/ready snapshots never replay an old turn");
});
