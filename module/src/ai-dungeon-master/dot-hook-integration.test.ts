import assert from "node:assert/strict";
import test from "node:test";
import { completedPlayerTurn, snapshotCombatTurn } from "./completed-player-turn.js";
import { createDotHookIntegration } from "./dot-hook-integration.js";
import type {
  CompletedPlayerTurnInput,
  DmControllerScope,
  DotTurnState,
} from "./dm-event-adapter.js";

void test("production dot seam selects only verified binding, current state and acknowledged submission", async () => {
  const callbacks = new Map<string, () => void>();
  const modules = new Map<string, { api?: unknown }>();
  const player = { id: "gm", isGM: true };
  let mode: unknown = "embedded";
  Object.assign(globalThis, {
    game: {
      user: player,
      modules,
      settings: {
        get: (_id: string, key: string) => {
          assert.equal(key, "dmEventMode");
          return mode;
        },
      },
    },
    Hooks: { on: (name: string, listener: () => void) => callbacks.set(name, listener) },
  });
  const integration = createDotHookIntegration();
  let changes = 0;
  integration.onChange!(() => {
    changes++;
  });
  assert.equal(integration.mode!(), "embedded");
  assert.equal(
    integration.scope!(),
    undefined,
    "GM status without a server binding is insufficient",
  );
  mode = "dot";
  assert.equal(integration.mode!(), "dot");

  const combat = {
    id: "combat",
    scene: "scene",
    active: true,
    round: 1,
    turn: 0,
    turns: [{ id: "player", actor: { hasPlayerOwner: true } }, { id: "npc" }],
    _stats: { modifiedTime: 10 },
  };
  const turn = completedPlayerTurn("world", { ...combat, turn: 1 }, snapshotCombatTurn(combat))!;
  const state: DotTurnState = {
    worldId: "world",
    sessionId: "session",
    controllerId: "controller",
    sceneId: "scene",
    combatId: "combat",
    combatModifiedTime: 10,
    round: 1,
    turn: 1,
    combatantIds: ["player", "npc"],
    paused: false,
  };
  const payload: CompletedPlayerTurnInput = {
    eventId: `turn-${"a".repeat(64)}`,
    timestamp: "2026-10-09T12:00:00.000Z",
    worldId: "world",
    sessionId: "session",
    controllerId: "controller",
    sceneId: "scene",
    combatId: "combat",
    stateRevision: "b".repeat(64),
    previous: turn.previous,
    next: turn.next,
  };
  const cancellation = new AbortController();
  await assert.rejects(integration.submit!(payload, cancellation.signal), /unavailable/);
  assert.equal(integration.currentState!(turn), undefined);

  const bindingState: { current?: DmControllerScope & { clientId: string; userId: string } } = {};
  let listener!: () => void;
  let detached = 0;
  let release!: () => void;
  let submissions = 0;
  const api = {
    getScope: () => bindingState.current,
    currentState: (combatId: string) => {
      assert.equal(combatId, "combat");
      return state;
    },
    submitCompletedTurn: (input: CompletedPlayerTurnInput, signal: AbortSignal) => {
      assert.strictEqual(input, payload);
      assert.strictEqual(signal, cancellation.signal);
      assert.equal("clientId" in input || "userId" in input || "lane" in input, false);
      submissions++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    onLifecycle: (callback: () => void) => {
      listener = callback;
      return () => {
        detached++;
      };
    },
    sendEvent: () => assert.fail("generic sendEvent must never submit a dot turn"),
  };
  modules.set("foundry-ai-dungeon-master", { api: { dot: api } });
  callbacks.get("ready")!();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(changes, 1, "API arriving after AI DM init is observed");
  assert.equal(integration.scope!(), undefined);
  const binding = {
    ...state,
    clientId: "verified-client",
    userId: "gm",
    connected: true,
    isController: true,
    automaticEventsEnabled: true,
  };
  bindingState.current = binding;
  listener();
  assert.equal(changes, 2);
  assert.strictEqual(integration.scope!(), binding);
  assert.strictEqual(integration.currentState!(turn), state);
  let completed = false;
  const pending = integration.submit!(payload, cancellation.signal).then(() => {
    completed = true;
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(completed, false, "bridge send waits for its acknowledgement");
  release();
  await pending;
  assert.equal(completed, true);
  assert.equal(submissions, 1);

  binding.userId = "other-user";
  assert.equal(
    integration.scope!(),
    undefined,
    "binding must belong to this authenticated observer",
  );
  binding.userId = "gm";
  player.isGM = false;
  assert.equal(integration.scope!(), undefined);
  player.isGM = true;
  modules.delete("foundry-ai-dungeon-master");
  assert.equal(integration.scope!(), undefined);
  assert.equal(detached, 1, "API replacement/removal detaches its lifecycle listener");
  assert.equal(changes, 3);
});
