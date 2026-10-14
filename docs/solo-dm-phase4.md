# Scoped tool discovery MVP

The existing authenticated response capability now owns one lazily created
TypeScript trusted catalog session. Python's same single model loop receives
three fixed wrappers: tool_search, tool_load and tool_execute. No additional
model runner, browser credential or raw MCP endpoint was introduced.

Frozen internal adapter operations:

| Operation    | Arguments                                                                                |
| ------------ | ---------------------------------------------------------------------------------------- |
| tool_search  | query (1..256 characters), limit (1..8)                                                  |
| tool_load    | searchId, toolId (1..128 characters)                                                     |
| tool_execute | grantId, effect (read, present, propose), arguments (JSON object matching loaded schema) |

These operations use the existing secret and world/user/thread-bound run headers.
Responses retain the adapter envelope containing the catalog ok/value or denial.
No commitAuthorization, model approval, provider URL or unrestricted tool name
can authorize execution. Four searches, six loaded schemas and twelve executions
are allowed per response; total discovery requests are also capped. Oversized
schemas/results refuse with an explicit transport-budget denial, never a silently
truncated usable schema. Expiry, disconnect, release or revoked live authorization
invalidates the response boundary. Catalog/schema/permission drift refuses grants.

Actual MCP read schemas are discovered for active scene/scene actors, current
world/system and active combat. Execution passes through the existing adapter's
bounded projections rather than returning raw GM documents. Hidden scene tokens
are removed; observations are labeled untrusted and non-narratable. Off-scene
actors must belong to the validated explicitly assigned party. Unknown tools,
arbitrary Foundry search, and raw transaction operations remain quarantined.

Two deliberately **semantic** TypeScript action definitions are exposed; they
are not claimed to be names advertised by the actual MCP endpoint:

| Definition                 | Effect  | Behavior                                                                                                                                         |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ai_dm_roll_dice            | present | actionId + bounded formula; invokes existing durable native dice, automatically, with no Foundry chat post                                       |
| ai_dm_propose_private_note | propose | actionId + title + text; invokes existing durable private Journal proposal/preflight; authenticated human review is required before a game write |

Their revisions include actual dependency MCP input/output schema digests. Missing
native services/dependencies remove them from discovery; changes invalidate old
grants. A trusted server callback routes a validated grant to the reviewed facade;
the model cannot supply that callback. Stable native action IDs and durable native
dispatch claims/receipts enforce replay protection across runs/restarts.

Catalog invocation kind executed means the facade was invoked; it does **not**
mean a proposed game write completed. A private-note result remains pending until
human approval. A dice result can remain uncertain. Only the durable corresponding
completed receipt supports success narration. Provider failure after present or
propose dispatch is non-retryable; inspect durable state rather than issuing a
new ID. Existing fixed dice/private-note tools remain working too.

Door, Actor HP, inventory, movement, Actor/token creation and combat mutations
are unavailable in this MVP. Their general CRUD schemas do not establish safe
revision/idempotent policy. The existing strict transaction subset supports only
Journal/Item/Page operations; no unrestricted manifest is exposed to the model.

The panel action-review wire contract remains unchanged: discovered private notes
use existing native action views/approval. Campaign proposal review from Phase 3
continues to use its separately frozen kind:campaign views and batchDigest.

Offline evidence covers actual Python wrapper -> ephemeral authenticated HTTP
adapter -> trusted search/load/grant -> durable native service -> controlled MCP
fixture, plus drift, unknown tools, scope/revocation, argument/effect rejection,
stale preflight, duplicate/conflicting effects, uncertainty and cancellation.
This verifies contracts, not live Foundry behavior or deployment privacy. Loaded
build, real MCP/read-back and trigger gates remain separate live acceptance work.
