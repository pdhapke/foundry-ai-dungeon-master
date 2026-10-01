# Ordered ChatKit turns and application triggers

TypeScript's authenticated `/chatkit` gateway is the authoritative inference ingress. Both ordinary typed messages and `module.api.trigger` / ChatKit custom actions enter one serial queue per authenticated world. Python retains its single model loop and its conversation store. No second agent or expanded native action catalog is introduced.

The SDK operation boundary is closed: only create/add-user-message/custom-action/retry-after-item inference and reviewed thread/history/feedback storage operations are accepted. SDK client tool output, structured input, synchronous actions, transcription, attachments and unknown future operations are rejected before provider dispatch in Node and defensively in Python. The current panel does not expose those unsupported flows; typed chat, custom context actions and conversation history remain supported.

The panel exposes **Ask DM**, **Resolve Action**, **Cancel response**, and the existing native confirmation review. Resolve Action asks for missing player intent; it cannot grant permission to unsupported game mutations. Native execution remains bounded dice and explicitly confirmed private session JournalEntry only.

## Event identity and recovery

`chatkit_turns` in the existing server SQLite database records world, event ID, authenticated owner, envelope hash, correlation ID, origin hint, creation time and status. Hook IDs derive from document ID and authoritative document revision; duplicate delivery across GM browsers/world clients returns 409 before any provider request. Caller origin hints never confer authority. Context is still rebuilt by the existing world/principal capability service after queue admission.

The browser adds `x-ai-dm-event` to inference requests. Until a stream completes, a world/user-scoped browser pointer preserves that ID by SHA-256 of the envelope. Pointers contain IDs and hashes, not message text or credentials. A reconnect repeating the same unresolved envelope therefore uses the same durable ID. Custom actions carry their stable `requestId` and it takes precedence. The server bounds outstanding turns to 32 per world and enforces the existing deadline/cancellation mechanism while waiting and streaming. Custom actions also queue in the mounted panel; cancellation invalidates queued panel actions.

Queued cancellation records `cancelled`; an aborted dispatched stream records `interrupted`. Server restart changes leftover queued/running records to interrupted. Completed transport records `settled`, which means the request finished, **not** that a model answer or mutation succeeded. Replaying any recorded ID is refused. Recovery is deliberately conservative: reopen conversation history, inspect native receipts, then explicitly submit a new request if warranted. Interrupted work is never silently reissued. Read actual tool receipts before describing any outcome. An incomplete network delivery can still have an uncertain native receipt; never infer failure means no effect.

## Selected opt-in signals

The world setting `automaticEventsEnabled` defaults off. Enabling it listens only to door opening (`updateWall` with `ds=1` and modifiedTime), player-owned actor combat turn completion (pre-update ownership check plus `updateCombat`), and the explicit `foundry-ai-dungeon-master.keyedAreaEntered` integration hook. It does not subscribe to all document changes or raw token movement.

A keyed Region integration emits the following after a **real entry**, using an authoritative revision that stays the same across duplicate client deliveries:

```javascript
Hooks.callAll("foundry-ai-dungeon-master.keyedAreaEntered", {
  kind: "area", documentId: token.id, key: "keyed-room-slug",
  revision: token._stats.modifiedTime,
  origin: "player"
});
```

The campaign key is a bounded slug and becomes untrusted retrieval-query data, never executable instructions. Region setup is intentional: this release does not guess polygon/room associations. Rapid entries for one document coalesce for 250ms. Missing revision/key is ignored. `origin: "ai-dungeon-master"` / document update `options.aiDmOrigin` suppress echoes; new native mutation implementations must propagate this marker. Current native dice/private notes do not update watched walls or combat documents. Combat auto narration requires the previous actor's `hasPlayerOwner` and a local preUpdateCombat; non-player turns and remote-only pre-update events are skipped conservatively. Explicit Ask DM remains available for those situations.

## Controlled validation and live limits

At module root run `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and `npm run check:manifest`. At `chatkit-server` run `.venv/Scripts/python.exe -m unittest test_app`. Focused gate: `node --import tsx --test server/src/chatkit/turns.test.ts server/src/chatkit/gateway.test.ts module/src/ai-dungeon-master/automatic-triggers.test.ts module/src/ai-dungeon-master/chatkit-context.test.ts module/src/ai-dungeon-master/application.test.ts`.

Fixtures exercise real HTTP/streams and SQLite including actual file close/reopen, serial mixed prompt/action ingress, duplicate delivery, multiple principals, cancellation, restart retention, bounded context sentinels, coalescing, and AI echo suppression. Browser component, Foundry hooks/MCP, sidecar provider and model are mocked. Live Foundry hook timing, Region integration, cross-browser SDK reconnection and live model narration require Gate 6; these fixture results do not establish live acceptance.
