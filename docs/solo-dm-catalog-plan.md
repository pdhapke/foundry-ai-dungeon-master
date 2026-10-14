# Phase 4 scoped discovery bridge patch plan

Read-only design, October 1, 2026. This document is not a feature or live-schema
claim. Phase 3 must pass independent validation before shared adapter/Python
ownership transfers. Offline-only authorization and unchanged configuration apply.

## Bounded wire contract

Reuse `/internal/chatkit/read`, its internal secret, response capability, world,
user and thread headers. Add strict operations (reject unknown fields):

| Operation | Arguments | Success value |
| --- | --- | --- |
| `tool_search` | `{query: string<=256, limit: integer1..8}` | Existing catalog search result containing searchId, descriptors and catalog/policy revisions |
| `tool_load` | `{searchId:string, toolId:string}` | Existing loaded definition+grant, bounded schema output |
| `tool_execute` | `{grantId:string, effect:read|simulate|propose, arguments:object, actionId?:string}` | Existing executed/proposal-required outcome or durable native pending/completed/uncertain receipt |

Python fixed wrappers map snake_case parameters into these exact argument names.
Use a typed object for the schema arguments; never parse an unrestricted raw MCP
JSON command from conversational text. Return the existing `{ok,result}` adapter
envelope and explicit typed catalog denial inside its result. Search/load/grant
identifiers can contain catalog's colon-prefixed UUIDs; do not incorrectly reuse
Foundry document-ID validation for them. Cap individual IDs to 128 characters.
`actionId` follows native action ID rules and is mandatory for a routed effect.
No model-supplied commitAuthorization, provider URL, principal or credential.

Each response capability owns one `ToolCatalogRunSession` and a new random run ID.
Instantiate lazily after thread binding/current-world authorization. Retain search
and loaded grants until the response capability releases. Budgets: at most four
searches, six loads, twelve executions, plus existing overall adapter budget.
Keep normal context allocation from consuming every discovery budget. Schema
responses exceeding transport allocation yield a typed bounded-schema denial;
no silent truncation of a usable input schema. Python keeps the one existing loop.

## Projection and policy enforcement

Discovery does not justify returning raw GM provider reads. An executing session
must use a reviewed provider facade whose calls return bounded adapter projections:
active scene only; scene/explicit-party Actor only; current authorized world/system;
bounded active combat; schema/validation outputs constrained to harmless data.
Reuse `ChatKitReadTools.execute` read operations for those projections where
possible, while avoiding recursive catalog search execution. Extract a private
read projection helper if necessary; do not expose a second public raw endpoint.

The actual MCP tools/list remains the authoritative schema source. Preserve exact
tool names, hashes and revision drift checks. The facade performs world/current GM
checks before/after each MCP call, signal/deadline/expiry checks, and projection.
Plain read metadata cannot override scope. Every output remains untrusted data.
Keep unknown names quarantined. General `foundry_search` may find all GM documents;
exclude it from executable MVP until a bounded disclosure-aware projection exists.
Never expose full journal content, arbitrary Actors or every combat through a raw
catalog result just because the provider authenticated as GM.

## Honest useful MVP

Yes: discovery can support the reviewed read set plus the **existing** durable
dice/private-note semantic actions. This satisfies useful game execution without
adding unsafe door/HP/movement/combat/Actor mutations. It must be described as
that narrow action set; those other effects remain explicitly unsupported.

Dice route: load actual `foundry_roll_dice` schema, but permitted arguments are
further restricted to the existing native bounded formula policy. `tool_execute`
requires stable actionId and forwards the selected formula to `native_roll`;
never directly invokes the raw roll endpoint or accepts optional arbitrary `data`.
Return only the native durable receipt, preserving automatic dice and no chat post.
Dice is a non-idempotent effect despite the provider endpoint's simple schema.

Private-note route: do **not** load/execute unrestricted
`foundry_execute_transaction` with a model-generated manifest. Advertise a reviewed
semantic catalog action such as `ai_dm_propose_private_note` whose schema is
`{title<=120,text<=4000}`. Its provider is a trusted TypeScript adapter that invokes
`native_propose_note`, which already constructs the GM-private Journal manifest,
preflights it, and stores approval state. Underlying MCP schema digests/revisions
must contribute to this semantic definition revision; quarantine/unavailable when
preflight/transaction/read-back schemas are missing or change incompatibly.
Execute is proposal-only; authenticated panel approval uses existing `/actions`.
Pending is not executed, and no discovery grant becomes human approval.

Semantic action schemas must be distinguished from actual MCP schemas in docs.
Implement a reviewed provider facade/composite that can define these two
high-level actions and route their invocation durably; do not claim the bridge
advertises an actual MCP private-note endpoint. An alternative is to leave both
native mutations as fixed wrappers and expose only bounded read discovery,
explicitly describing discovery mutation as unavailable. That narrower alternative
does not prove discovered mutation execution and must not be counted as such.

Existing actor/token/combatant creation overlays lack expected-revision and
idempotent-commit guarantees. Preserve proposal-only status or omit them from
this MVP view. Strict transaction schemas only support JournalEntry/Item and
JournalEntryPage records, not doors, Actor HP, token movement or combat advances.

## Runtime changes needed

Current `executeGrant` refreshes catalog and checks expiry/catalog revision/policy
view/schema/effects before dispatch. Retain that path, but add an injectable
reviewed execution boundary/facade for durable semantic actions; do not manually
skip grant validation to call native actions. Session scope and cancellation must
reach the provider facade, which currently lacks a request signal in
`invokeSelected`/`FoundryLocalApiProviderAdapter`.

After grant loading, catalog/schema drift should refuse execution. Permission
snapshot revision is currently a constant string; live reauthorization is still
required even when this catalog digest does not change. World/user/thread/token
revocation must prevent search, load, proposal and execution, not just reads.
Release invalidates all grants. Do not reuse a prior response's search/grant IDs.

Current provider catch returns TOOL_UNAVAILABLE with retryable:true for every
failure, including after a mutation may have occurred. Correct it so dispatched
consequential effects are never automatically retryable. Durable native dispatch
uncertainty wins over catalog generic errors. For harmless reads, retryability
may remain true, but cancellation/revocation never invites a hidden retry.
Catalog's in-memory idempotency map is not mutation replay proof; rely on durable
native receipts and exact scope/input digest. Do not advertise commit guarantees
on raw provider tools merely to enable the generic runtime.

## Ownership and evidence

After Phase 3 PASS: transfer read-tools.ts/tests from campaign authoring owner to
catalog worker; catalog worker owns catalog facade/new bridge/runtime tests and
metadata/runtime changes. Root alone owns server wiring. Python owner then receives
this frozen JSON plus Phase 3 operation shapes and owns app.py/test_app.py wrapper
integration. Prompt assignment is already versioned; no additional runner.

Offline independent validation must cover Python wrapper arguments -> authenticated
adapter -> search -> load -> grant -> facade -> controlled MCP endpoint; actual
read projections; unknown schemas; unsafe fields; unauthorized effects; drift;
scope mismatch; release/expiry/revocation; noncooperative cancellation; output
budget; dice duplicate/conflicting action ID; note proposal approval; restart;
stale preflight; uncertain execution; no retry. Mock provider evidence proves
contracts, never real Foundry execution or loaded build. Live acceptance remains
BLOCKED until separately authorized.
