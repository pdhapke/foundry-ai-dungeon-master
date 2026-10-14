# Scoped dot MCP Events contract

Status: local implementation and synthetic validation only. These files alone
open no endpoint, create no platform subscription, and provision no tunnel or
credential. Live integration is a separate checkpoint. The existing
administrative MCP and embedded ChatKit/Python remain intact.

## Producer and state identity

The bridge event name is `foundry.player_turn_completed`. Its payload is:

```ts
{
  eventId: `turn-${sha256Hex}`,
  timestamp: string, // ISO 8601 occurrence time
  worldId: string, sessionId: string, controllerId: string,
  sceneId: string, combatId: string, stateRevision: string,
  previous: { round: number, turn: number, combatantId: string },
  next: { round: number, turn: number, combatantId: string }
}
```

All identifiers are 1–128 ASCII letters, digits, underscores or hyphens. The event
ID is `turn-` plus lowercase SHA-256 of UTF-8 `JSON.stringify` of this ordered
array (without spaces):

```js
["foundry-player-turn-v1", worldId, sessionId, controllerId, sceneId, combatId,
 previous.round, previous.turn, previous.combatantId,
 next.round, next.turn, next.combatantId, stateRevision]
```

Timestamp is excluded: repeat observations of the same transition deduplicate.
The producer, context-read tool and response guard MUST share the same state
projection and ordered serialization. The version-one state revision is lowercase
SHA-256 of UTF-8 `JSON.stringify` of:

```js
["foundry-dot-state-v1", worldId, sessionId, controllerId, sceneId, combatId,
 combatModifiedTime, round, turn, combatantIds, paused]
```

`combatModifiedTime` is the authoritative Combat `_stats.modifiedTime`, a
nonnegative safe integer; `combatantIds` is the complete current initiative order
(at most 256 IDs). `paused` is the authoritative boolean. Missing fields refuse
the event/state read; do not invent defaults or independently hash a different
projection. The ingress validates but does not recompute Foundry's state revision.

Call `DotEventService.enqueueCompletedTurn(payload, verifiedBridgeIdentity)` only
from the authenticated GM bridge ingress. The separate identity argument is
`{clientId,userId,lane:"gm"}` and must come from session verification. MCP clients
cannot enqueue observations. An injected ingress guard must validate the actual
world/session/controller, active scene, forward player transition and current
revision. Suppress executor-originated mutations in the producer, and never
deliver one observation to both embedded and dot controllers.

## Event subscriptions and cursors

Subscriptions require exact `worldId`, `sessionId`, `controllerId`; optional
`combatId` narrows further. Each owner is an authenticated server principal,
never self-reported MCP clientInfo. Callback identity uses owner, canonical
filters and normalized HTTPS callback URL. This identity is idempotent.

Webhooks contain `{eventId,name,timestamp,data,cursor}`. `name` is
`foundry.player_turn_completed`; `data` contains the producer fields except ID
and timestamp. Payloads contain state hints, never instructions or execution
authority. The dot reads current Foundry state before responding.

Cursors encode the store generation and global event sequence. They mean
"completed delivery through this sequence", not "latest event exists". Each
subscription advances only through contiguous matching events whose webhook
receipt is acknowledged (or explicitly terminal); pending events cannot be
skipped. Fresh subscriptions start at the current tail; they do not replay old
game turns. Explicit replay cursors resume retained history; incompatible or
expired history returns `truncated:true` without pretending a full replay.
Retained deduplication/history is bounded, so the producer must also reject stale
turns via fresh state/session guards.

At most eight subscriptions may be active at once. Expired/stopped identities
do not consume active capacity. Up to 64 identities and their retained event
delivery records preserve bounded replay/deduplication; adding another identity
reclaims the oldest stopped identity and its delivery records. Event history is
bounded to 1024 entries; pending deliveries cannot be discarded to make room.

Successful callback verification is cached in memory for five minutes by
authenticated principal and normalized callback URL, with a digest of the signing
key. Repeated refreshes do not extend this verification deadline. A changed key
requires a fresh challenge before replacing the stored key; the previous key
adds a second signature for a 60-second rotation window. The cache holds at most
64 entries and is empty after restart. DNS/address validation still occurs on
every verification or event connection, including cached refresh delivery.

## Integration boundary

`mountDotMcp(app, options)` mounts a separate `/dot/mcp` modern HTTP endpoint.
It requires request authentication and scoped tool list/call callbacks. Event
service construction requires subscription authorization, ingress authorization,
current delivery/controller authorization, private storage verification, and a
server-owned secret codec. Missing callbacks fail closed. No administrative
catalog, macro execution, arbitrary upload or broad document CRUD is forwarded.

The integration owner must mount before the existing catch-all handler, after
the correct local authentication boundary. Tunnel forwarding targets only this
endpoint; do not configure a tunnel to the broad `/mcp` catalog.

The integration owner supplies explicit start/stop polling for `dispatchDue()`.
The service itself opens no listener and starts no timer. Pause/stop expires or
disables the controller guard; reconnects must preserve the same verified scope
or require a fresh session/controller. Webhook retries repeat delivery only,
not model inference or Foundry mutations. A 2xx means callback receipt, not a
completed dot response. Idempotent response publication and uncertain-write
reconciliation belong in the scoped Foundry tools.

Authentication must identify the caller independently of active controller
scope. An authenticated owner can unsubscribe its own exact identity even after
scope revocation. The delivery claim rechecks current revision, expiry, queued
state and ordering synchronously after any awaited authorization; cancellation
cannot overwrite a queued item as in-flight or be undone by a late receipt.
Subscription requests capture the cancellation generation at invocation,
before queuing and the first awaited authorization. A later unsubscribe/stop
invalidates those older requests before verification or persistence; a new
explicit subscribe issued after the stop remains eligible for authorization.

Synthetic validation uses the existing TypeScript compiler and Node's isolated
test runner with mocked callbacks and temporary storage. From AI Dungeon Master's
module root, run `node --import tsx --import ./scripts/test-events-core-register.mjs
--test --test-concurrency=1 server/src/dot-integration/*.test.ts
server/src/legacy-delivery/*.test.ts`. The test-only loader resolves the generic
API event facade to its source; production uses the built facade. Validate the
generic transport separately in Foundry Local API with `node --import tsx --test
--test-concurrency=1 server/src/mcp-events/*.test.ts`. These checks need no live
Foundry, credentials, tunnel, model call or platform subscription.

## Sources

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [MCP 2026-07-28 HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Custom MCP server setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)

