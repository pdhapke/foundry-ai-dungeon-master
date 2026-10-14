# Automatic solo-DM observations

Offline implementation, October 1, 2026. The ordinary composer retains the same permanent DM identity. Optional automatic observations use the existing Python model loop and existing durable per-world TypeScript ingress queue.

## Producers and correlation

The supported Foundry `CONFIG.RegionBehavior.dataModels` extension registers `foundry-ai-dungeon-master.keyedArea`, with a campaign resource `key` field and `tokenEnter` handler. Empty keys, hidden tokens/Regions, disabled behaviors and tokens without player ownership do not narrate. Distinct Regions and genuine reentries remain distinct. Registration uses the installed RegionBehaviorType API; no vendor code changes.

Door observers maintain previous wall state and narrate closed-to-open door transitions. GM-operated doors require a player-owned token in the active scene. Combat observers initialize previous snapshots and consume `updateCombat` on every client, including remote updates; only adjacent forward transitions from an actual player-owned combatant qualify. Initialization, backward movement, changed combatant ordering and repeated updates do not count as completed turns.

Observers run only for authenticated connected GMs with automatic events enabled, the same world, and the active canvas scene. They send bounded observation data, never execution authority. Each event ID is SHA256 of the compact JSON identity array `[kind,worldId,sceneId,documentId,tokenId-or-null,regionId-or-null,key-or-null,revision,transition]`, prefixed by its kind. Both authenticated Node ingress and Python validate the exact optional automatic schema; Node enforces principal/world scope. Durable event records deduplicate GM clients and survive restart. Interrupted inference is recorded, never blindly replayed.

The related local-api executor adds structured `foundryLocalApiOrigin={source:"foundry-local-api.transaction",phase:"apply"|"compensate",correlationId}` to all validated transaction mutations and compensations. The source is executor-generated; model document fields are not copied into authority. Wall/combat observations suppress that structured echo marker. Marker suppression is observational, never a permission grant.

Current reviewed transaction capabilities mutate JournalEntry/Item/JournalEntryPage, not Tokens, Walls or Combat. Core physical Region `tokenEnter` events do not expose arbitrary update options. Consequently no token-mutating capability is enabled by this implementation, and future token-control support requires an authoritative Region origin bridge before admission. Actual remote marker propagation remains a live gate.

## Cancellation

Identical observations coalesce for 250ms; distinct observations queue. Pending signals are capped at64 and the browser duplicate cache at1000/five minutes; durable server records remain authoritative. Panel cancellation, setting disable, disconnect, canvas teardown and world changes abort pending timers and already-dispatched automatic signals. Programmatic events wait for an ordinary response to finish. Abort signals reach thread creation and ChatKit authenticated requests, so queued server ingress can cancel before dispatch. Generation, mount owner and thread selection checks prevent late awaited work or stale component callbacks from reopening a cancelled response or writing a different world's thread pointer.

## Evidence and live limits

AI module35 tests pass, including mocked physical Region registration, door transition, remote combat, distinct hashes, duplicate clients, cancellation, panel ownership and existing panel review regressions. Four durable-turn tests pass against real SQLite, covering hash/world/user validation, cancellation, per-world ordering and restart recovery. Full server171 tests pass. These are deterministic protocol/component checks, not proof that Foundry hooks work live.

Related executor22 focused tests pass, including forward and compensation marker options. AI and related TypeScript checks/builds and scoped ESLint checks pass. `transactions.ts` was clean before the explicitly authorized additive changes; unrelated related-module dirty files remain untouched.

Live acceptance still requires approval for an isolated test-world fixture, reload/world/scene changes and an explicit billable-model budget. Verify loaded build identity, physical keyed Region entry, remote wall/combat updates from a second client, distinct reentries, duplicate observers, manual/event overlap, cancellation/reconnect/world switch and executor marker/read-back. Production private campaign writes remain disabled because direct static serving privacy has not been protected or verified; no security configuration, credentials, vendor code, deployment or live world resources were changed.

