import assert from "node:assert/strict";
import test from "node:test";
import {
  completedPlayerTurn,
  snapshotCombatTurn,
  type CompletedPlayerTurn,
} from "./completed-player-turn.js";
import {
  canonicalDotTurnState,
  completedTurnEventId,
  DmEventAdapter,
  dotTurnStateRevision,
  type CompletedPlayerTurnInput,
  type DmControllerScope,
  type DmEventAdapterDependencies,
  type DotTurnState,
} from "./dm-event-adapter.js";

const revision = "0e6105d22d840f1a1c23392421bd347c7d9a418931bed85d8119cdb61d9392b8";
const eventId = "turn-4b5f6be6c7ed488c3c0037db776c37403580cbe1b2bc7930f5c3c85b0305ba4f";
const turn = (): CompletedPlayerTurn => {
  const combat = {
    id: "combat",
    scene: "scene",
    active: true,
    round: 1,
    turn: 0,
    turns: [{ id: "player", actor: { hasPlayerOwner: true } }, { id: "npc" }],
    _stats: { modifiedTime: 10 },
  };
  return completedPlayerTurn("world", { ...combat, turn: 1 }, snapshotCombatTurn(combat))!;
};

function fixture(overrides: Partial<DmEventAdapterDependencies> = {}, maximum = 256) {
  const scope: DmControllerScope = {
    worldId: "world",
    sessionId: "session",
    controllerId: "controller",
    sceneId: "scene",
    connected: true,
    isController: true,
    automaticEventsEnabled: true,
  };
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
  const embedded: unknown[] = [],
    submitted: CompletedPlayerTurnInput[] = [];
  const mutable = { mode: "dot", reads: 0 };
  const dependencies: DmEventAdapterDependencies = {
    mode: () => mutable.mode,
    embedded: (signal) => {
      embedded.push(signal);
    },
    scope: () => scope,
    currentState: () => {
      mutable.reads++;
      return state;
    },
    submit: (input, cancellation) => {
      assert.equal(cancellation.aborted, false);
      submitted.push(input);
      return Promise.resolve();
    },
    now: () => new Date("2026-10-09T12:00:00.000Z"),
    ...overrides,
  };
  return {
    scope,
    state,
    mutable,
    embedded,
    submitted,
    dependencies,
    adapter: new DmEventAdapter(dependencies, maximum),
  };
}

void test("v1 canonical state and event hashes match fixed cross-worker contract vectors", async () => {
  const { state } = fixture();
  assert.equal(
    canonicalDotTurnState(state),
    '["foundry-dot-state-v1","world","session","controller","scene","combat",10,1,1,["player","npc"],false]',
  );
  assert.equal(await dotTurnStateRevision(state), revision);
  assert.equal(
    await completedTurnEventId({
      worldId: "world",
      sessionId: "session",
      controllerId: "controller",
      sceneId: "scene",
      combatId: "combat",
      stateRevision: revision,
      previous: turn().previous,
      next: turn().next,
    }),
    eventId,
  );
  assert.notEqual(await dotTurnStateRevision({ ...state, paused: true }), revision);
  assert.notEqual(
    await dotTurnStateRevision({ ...state, combatantIds: ["npc", "player"] }),
    revision,
  );
});

void test("missing mode selects only embedded handling and never reads an external session", async () => {
  const f = fixture();
  delete f.dependencies.mode;
  f.dependencies.scope = () => assert.fail("default mode must not use bridge scope");
  assert.deepEqual(await f.adapter.accept(turn()), { status: "embedded" });
  assert.equal(f.embedded.length, 1);
  assert.equal(f.submitted.length, 0);
  assert.equal(f.mutable.reads, 0);
});

void test("dot handoff includes fresh state/session metadata and no chat, cursor, or caller identity", async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.accept(turn()), { status: "submitted" });
  assert.equal(f.embedded.length, 0);
  assert.equal(f.mutable.reads, 2);
  assert.deepEqual(f.submitted, [
    {
      eventId,
      timestamp: "2026-10-09T12:00:00.000Z",
      worldId: "world",
      sessionId: "session",
      controllerId: "controller",
      sceneId: "scene",
      combatId: "combat",
      stateRevision: revision,
      previous: { round: 1, turn: 0, combatantId: "player" },
      next: { round: 1, turn: 1, combatantId: "npc" },
    },
  ]);
});

void test("concurrent observations and repeated hooks submit once", async () => {
  const f = fixture();
  const results = await Promise.all([f.adapter.accept(turn()), f.adapter.accept(turn())]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["duplicate", "submitted"]);
  assert.equal((await f.adapter.accept(turn())).status, "duplicate");
  assert.equal(f.submitted.length, 1);
});

void test("reobserving one turn after a mode switch cannot route it to a second controller", async () => {
  for (const initialMode of ["embedded", "dot"]) {
    const f = fixture();
    f.mutable.mode = initialMode;
    assert.equal(
      (await f.adapter.accept(turn())).status,
      initialMode === "embedded" ? "embedded" : "submitted",
    );
    f.mutable.mode = initialMode === "embedded" ? "dot" : "embedded";
    f.adapter.cancel();
    assert.equal((await f.adapter.accept(turn())).status, "duplicate");
    assert.equal(f.embedded.length + f.submitted.length, 1);
  }
});

void test("unknown mode, absent bridge, inactive controller, disconnect and disabled automation fail closed", async () => {
  for (const mode of ["bad", "", "DOT"]) {
    const f = fixture();
    f.mutable.mode = mode;
    assert.equal((await f.adapter.accept(turn())).status, "suppressed");
    assert.equal(f.embedded.length + f.submitted.length, 0);
  }
  const absent = fixture({ scope: () => undefined });
  assert.equal((await absent.adapter.accept(turn())).status, "suppressed");
  for (const change of [
    { connected: false },
    { isController: false },
    { automaticEventsEnabled: false },
    { worldId: "other" },
    { sceneId: "other" },
    { sessionId: "" },
    { controllerId: "" },
  ]) {
    const f = fixture();
    Object.assign(f.scope, change);
    assert.equal((await f.adapter.accept(turn())).status, "suppressed");
    assert.equal(f.embedded.length + f.submitted.length, 0);
  }
});

void test("only the elected controller observer submits a shared turn", async () => {
  const owner = fixture(),
    observer = fixture();
  observer.scope.isController = false;
  assert.deepEqual(
    (await Promise.all([owner.adapter.accept(turn()), observer.adapter.accept(turn())])).map(
      (result) => result.status,
    ),
    ["submitted", "suppressed"],
  );
  assert.equal(owner.submitted.length + observer.submitted.length, 1);
});

void test("structured bridge-origin mutation cannot enter either controller", async () => {
  for (const mode of ["dot", "embedded"]) {
    const f = fixture(),
      event = turn();
    f.mutable.mode = mode;
    event.signal.bridgeOrigin = {
      source: "foundry-local-api.session-action",
      phase: "apply",
      correlationId: "operation-one",
    };
    assert.equal((await f.adapter.accept(event)).status, "suppressed");
    assert.equal(f.embedded.length + f.submitted.length, 0);
  }
});

void test("late callbacks after mode, session, controller, scene, world or connection change never hand off", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => {
      f.mutable.mode = "embedded";
    },
    (f: ReturnType<typeof fixture>) => {
      f.scope.sessionId = "session-two";
    },
    (f: ReturnType<typeof fixture>) => {
      f.scope.controllerId = "controller-two";
    },
    (f: ReturnType<typeof fixture>) => {
      f.scope.sceneId = "scene-two";
    },
    (f: ReturnType<typeof fixture>) => {
      f.scope.worldId = "world-two";
    },
    (f: ReturnType<typeof fixture>) => {
      f.scope.connected = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.scope.isController = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.scope.automaticEventsEnabled = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.adapter.cancel();
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(),
      pending = f.adapter.accept(turn());
    mutate(f);
    assert.equal((await pending).status, "suppressed");
    assert.equal(f.embedded.length + f.submitted.length, 0);
  }
});

void test("missing or stale current combat state refuses old events", async () => {
  const missing = fixture({ currentState: () => undefined });
  assert.equal((await missing.adapter.accept(turn())).status, "suppressed");
  for (const change of [
    { combatModifiedTime: 11 },
    { round: 2 },
    { turn: 0 },
    { combatId: "other" },
    { worldId: "other" },
    { sessionId: "other" },
    { controllerId: "other" },
    { sceneId: "other" },
    { combatantIds: ["npc", "player"] },
  ]) {
    const f = fixture();
    Object.assign(f.state, change);
    assert.equal((await f.adapter.accept(turn())).status, "suppressed");
    assert.equal(f.submitted.length, 0);
  }
});

void test("handoff revalidates the forward transition and previous combatant against current order", async () => {
  for (const previous of [
    { round: 1, turn: 0, combatantId: "other" },
    { round: 1, turn: 1, combatantId: "npc" },
    { round: 3, turn: 0, combatantId: "player" },
    { round: 1, turn: 256, combatantId: "player" },
  ]) {
    const f = fixture(),
      event = turn();
    event.previous = previous;
    assert.equal((await f.adapter.accept(event)).status, "suppressed");
    assert.equal(f.submitted.length, 0);
  }
});

void test("state changes during hashing are rejected and an unchanged reobservation can proceed", async () => {
  const f = fixture(),
    pending = f.adapter.accept(turn());
  f.state.paused = true;
  assert.equal((await pending).status, "suppressed");
  assert.equal(f.submitted.length, 0);
  assert.equal((await f.adapter.accept(turn())).status, "submitted");
  assert.notEqual(f.submitted[0]!.stateRevision, revision);
});

void test("an uncertain handoff stays deduped across same-session reconnect and never falls back", async () => {
  let attempted = 0;
  const f = fixture({
    submit: () => {
      attempted++;
      return Promise.reject(new Error("Synthetic ambiguous receipt"));
    },
  });
  assert.equal((await f.adapter.accept(turn())).status, "failed");
  f.scope.connected = false;
  f.adapter.cancel();
  f.scope.connected = true;
  assert.equal((await f.adapter.accept(turn())).status, "duplicate");
  assert.equal(attempted, 1);
  assert.equal(f.embedded.length, 0);
});

void test("fresh session/controller creates a new scoped event identity", async () => {
  const f = fixture();
  assert.equal((await f.adapter.accept(turn())).status, "submitted");
  f.adapter.cancel();
  f.scope.sessionId = f.state.sessionId = "session-two";
  f.scope.controllerId = f.state.controllerId = "controller-two";
  assert.equal((await f.adapter.accept(turn())).status, "submitted");
  assert.equal(f.submitted.length, 2);
  assert.notEqual(f.submitted[0]!.eventId, f.submitted[1]!.eventId);
});

void test("payload observation changes during async hashing cannot rewrite the original transition", async () => {
  const f = fixture(),
    event = turn(),
    pending = f.adapter.accept(event);
  event.previous.combatantId = "changed";
  event.next.combatantId = "changed";
  event.signal.documentId = "changed";
  assert.equal((await pending).status, "submitted");
  assert.equal(f.submitted[0]!.eventId, eventId);
});

void test("bounded in-flight dedupe rejects capacity without a second queue or delivery cursor", async () => {
  let release: (() => void) | undefined;
  const f = fixture(
    {
      submit: async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    },
    1,
  );
  const pending = f.adapter.accept(turn());
  const different = turn();
  different.signal.transition = "other-observation";
  assert.equal((await f.adapter.accept(different)).status, "capacity");
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  assert.equal((await pending).status, "submitted");
  assert.throws(() => new DmEventAdapter(f.dependencies, 0), /capacity/);
});

void test("invalid state projection is not hashed with fabricated defaults", async () => {
  const { state } = fixture();
  for (const change of [
    { combatModifiedTime: -1 },
    { combatModifiedTime: 1.5 },
    { turn: -1 },
    { round: 0 },
    { combatantIds: [] },
    { combatantIds: ["player", "player"] },
    { combatantIds: Array.from({ length: 257 }, (_, index) => `c${index}`) },
    { worldId: "bad id" },
  ])
    assert.throws(() => canonicalDotTurnState({ ...state, ...change }), /Incomplete/);
  const incomplete = { ...state } as Partial<DotTurnState>;
  delete incomplete.paused;
  assert.throws(() => canonicalDotTurnState(incomplete as DotTurnState), /Incomplete/);
  for (const field of ["worldId", "sessionId", "controllerId", "sceneId", "combatId"] as const) {
    const incompleteIdentity = { ...state } as Partial<DotTurnState>;
    delete incompleteIdentity[field];
    assert.throws(() => canonicalDotTurnState(incompleteIdentity as DotTurnState), /Incomplete/);
  }
  await assert.rejects(
    completedTurnEventId({
      worldId: "world",
      sessionId: "session",
      controllerId: "controller",
      sceneId: "scene",
      combatId: "combat",
      stateRevision: "invalid",
      previous: turn().previous,
      next: turn().next,
    }),
    /Invalid/,
  );
});
