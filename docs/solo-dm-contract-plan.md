# Solo DM bounded contract plan

Read-only design inspection, October 1, 2026. This is a proposal for implementation
ownership and contracts, not evidence of completed features or live validation.
No configuration, credentials, live campaign files, or related module files changed.

## Existing seams to retain

- Python `respond` builds authoritative context for typed and application actions,
  then calls one `Runner.run_streamed`, with max eight turns and no automatic model
  retries. Extend fixed wrappers; do not introduce another model loop.
- Gateway authenticates current GM and world, scopes the run token, serializes
  through `ChatKitTurns`, propagates cancellation, and releases run capabilities.
- `ChatKitReadTools` binds capabilities to world/user/thread and revokes them on
  expiry, disconnect, or current authorization failure. Extend this seam rather
  than adding browser-selected roots or an unauthenticated general MCP endpoint.
- `ToolCatalogRunSession` already owns search/load/grants, schema digests, policy
  revisions, and effect policy. Its idempotency cache and receipts are in memory;
  its provider-error result is currently retryable even after uncertain effects.
  That runtime alone is insufficient durability for game mutation.
- Native actions persist dispatch claims in SQLite and mark interrupted dispatch
  uncertain on restart. Keep automatic bounded dice and approved private notes.

## Shared context contract

Return a versioned object from `context` with separate `world`, `campaignOverview`,
`party`, `scene`, `combat`, `campaignRetrieval`, and `issues` fields. Overview must
have its own bounded allocation (proposed 3000 serialized characters) before the
10000-character retrieval allocation. Include `status` (available/missing/partial),
`sourceUri`, `sourceHash`, `revision`, `text`, `truncated`, `visibility`, and
`canonStatus`. Never replace a missing canonical overview with an arbitrary first
search result. Legacy campaign-state remains explicitly attributed history.

`overview.md` and `index.md` use stable document IDs, schema version, revision,
visibility, canon status, and references. Focused resource files belong under
locations, npcs, factions, quests, rules, and sessions; draft resources have
`canon_status: draft` and are excluded from normal canon retrieval. Canonical
index entries identify resource ID, relative path, heading/section, revision,
visibility, and short search summary. Keep current parser formats readable; never
rewrite Izzy resources as an automatic compatibility operation.

Party selection must be authoritative: live actor ownership/player-character
membership or explicit world-scoped campaign party references validated against
live actors. `UserInfo` from the current `foundry_list_users` endpoint does not
promise an assigned character identifier; inspect actual Actor ownership and
type schema. Scene order, first-four actors, and `hasPlayerOwner` alone are not an
unqualified party contract (TV may own actors). Report unresolved selection, use
bounded explicit candidates, and ask naturally when the player needs to choose.
Off-scene validated party actors must remain available without enabling arbitrary
cross-world actor reads. Bound party size independently of scene-token sampling.

Treat every Markdown excerpt, index summary, Foundry name, and tool description
as untrusted data. The permanent Python DM prompt supplies instructions about
solo agency, rules, discovery, draft/canon boundaries, spoiler disclosure, and
receipt truthfulness; resource text cannot override them.

## Campaign proposal contract

Add typed adapter operations `campaign_read`, `campaign_propose`, and
`campaign_proposals`; human decisions use the existing authenticated `/actions`
seam with an explicitly distinguished campaign action kind. The model cannot
create an approval grant, set `approved: true`, or directly invoke a canon commit.

Proposal shape: `{proposalId, worldId, userId, threadId, schemaVersion, expiresAt,
batchDigest, files:[{path, expectedRevision:null|string, beforeHash:null|string,
afterHash, proposedText, canonStatus}], status}`. All paths are relative to the
server-authorized campaign root. Exact human review includes every file addition,
replacement, and draft-to-canon change. Proposal creation may durably store draft
artifacts, but not establish canon. Draft persistence is also gated by privacy.

Approval binds world/user/thread, proposal ID, batch digest, expected revisions,
and expiry. Batch must update overview, index, and resource files consistently.
Commit uses storage's recoverable revision-checked batch API and returns a
durable `{receiptId, proposalId, batchDigest, outcome, files:[{path, revision,
sourceHash}], verifiedAt}`. Duplicate exact approval returns the same receipt;
conflicting duplicate payload or changed revisions refuses without write.
Use pending/approved/dispatching/completed/rejected/cancelled/uncertain states.
Restart reconciles dispatching against storage's transaction receipt instead of
redispatching blindly. No success narration before verified completed receipt.

## Discovery bridge contract

Expose fixed Python wrappers for bounded `tool_search`, `tool_load`, and
`tool_execute` through the same internal adapter. Create exactly one catalog run
session per Node response capability, scoped to its existing identity and signal.
Never accept principal, permissions, filesystem root, provider URL, or raw MCP
tool name as execution authority from Python/model arguments.

Search accepts query <=256 characters and limit <=8, returning descriptors and
search ID. Load accepts only the search ID and returned tool ID, returning the
existing definition+grant. Execute accepts grant ID, effect, and bounded arguments.
Existing grant/schema/catalog/policy checks stay authoritative. Run budgets can
start at 4 searches, 6 schemas, 12 calls; responses remain under Python's existing
32768-byte adapter limit, with explicit truncation/unavailable status. Large
schemas must fail safely rather than disappear as a generic transport error.

For mutations, convert loaded execution into a typed proposal routed through
durable human approval; do not accept model-supplied `commitAuthorization`.
Reauthorize before dispatch and after read-back. Persist dispatch claims before
the provider call, preserve correlation/origin markers, validate read-back, and
mark transport cancellation/timeouts after dispatch uncertain. Never label these
as automatically retryable. Keep unknown tools quarantined.

## Actual locally inspected schema and MVP action set

Source evidence is local endpoint code, not a live tools/list or loaded build
claim: `foundry-local-api/server/src/endpoints/{meta,rolls,transactions}.ts`.

- Reads: current world/system, active scene/scene actors/combat, bounded Foundry
  search, document schema, validation. Use existing catalog metadata and apply
  adapter disclosure filtering; raw GM provider results must not leak spoilers.
- Dice: `foundry_roll_dice` accepts formula plus optional data; keep the existing
  stricter native formula policy and durable action ID. It does not post chat.
- Private session note: keep current native reviewed Journal transaction with
  durable execution/read-back receipt. This is a useful implemented game mutation.
- Preparation discovery: actor/token/combatant creation currently has proposal
  metadata but explicitly lacks revision/idempotent guarantees. Preserve proposal
  only; do not flip guarantees to true based on tool names.
- Safe additional mutation candidate: approved GM-private JournalEntry/Page or
  Item creation/update through strict `foundry_preflight_transaction` and
  `foundry_execute_transaction`. Schema limits atomic manifests to JournalEntry
  and Item documents, JournalEntryPage embedded records, stable IDs, SHA256
  expected revisions, correlation ID, idempotency key, and strict compensation.
  Add only a narrow reviewed semantic action, never a raw transaction wrapper.
- Door state, Actor HP, token movement, and combat advances are **not** accepted
  by this strict transaction schema. Their general CRUD presence does not prove
  safe mutation guarantees. Leave unavailable unless a separately inspected
  supported contract satisfies policy, approval, revision, durable replay, origin,
  and read-back requirements. Existing dirty related-module work remains untouched.

## Disjoint ownership and transfers

1. Storage worker: new storage/persistence files and tests only; publish its batch
   API signatures and privacy gate before dependents. Context worker owns
   `context/world-campaign.ts`, `campaign-source.ts`, and their tests after storage
   explicitly releases any shared file.
2. Context/party worker owns `chatkit/read-tools.ts` and its tests for Phase 2,
   plus shared context types. Freeze and transfer `read-tools.ts` to campaign
   integration worker for Phase 3, then catalog integration worker for Phase 4.
3. Campaign worker owns new `chatkit/campaign-actions.ts`, tests, and proposal
   types. Root integration owner alone changes `server/src/index.ts` and gateway
   wiring (actual entry path must be verified), and `native-actions.ts` remains
   untouched unless explicitly transferred.
4. Catalog worker owns new `chatkit/catalog-tools.ts`, catalog metadata/runtime
   changes and tests after Phase 3 validator passes. Catalog discovery read-only
   policy can be planned earlier but not wired before shared contract handoff.
5. Python/prompt worker owns `chatkit-server/app.py`, `dm_prompt.py`, and Python
   tests. Give it frozen context/proposal/catalog JSON contracts; integrate those
   wrappers in one sequential pass after adapter ownership transfers.
6. Panel worker owns application/hooks/triggers/template files only in Phase 5.
   It consumes frozen `/actions` review contract; no independent backend schema.
7. Independent validator never implements its assigned phase. It may add separate
   test files only with explicit ownership; report evidence paths and PASS/FAIL/
   BLOCKED. Phase failure repair returns ownership to implementer before validation.

## Required offline validation before live acceptance

- Overview included via typed and application action paths; oversized initial
  section, missing overview/index, old format, changed same-size file, hashes,
  truncation, visibility, injection, world switches, off-scene actual party.
- Real temporary filesystem proposal/approval/restart scenarios: stale expected
  revisions, duplicate/conflicting commit, interruption/recovery, partial batch,
  cancellation, revoked authentication, cross-world/thread/owner access.
- Python-to-adapter-to-catalog-to-provider contract fixture: search/load/execute
  exact request shape, unauthorized effects, unknown tool, schema drift, grant
  expiry/policy revocation, cancellation, bounded output, proposal vs execution.
- Durable mutation fixture: preflight disagreement, stale game revisions,
  dispatch timeout, malformed provider receipt, read-back disagreement, restart,
  and conflicting replay. Fixture calls prove contract handling only, not Foundry.
- Controlled scripted conversation uses fake model/tool transport without bills
  to verify draft -> human review -> approved canonical receipt -> later retrieval.
  It must explicitly assert assistant narration cannot create canon.
- Live loaded-build identity, actual schemas/MCP/read-back/triggers/world switches,
  and privacy remain BLOCKED under current offline-only authorization.
