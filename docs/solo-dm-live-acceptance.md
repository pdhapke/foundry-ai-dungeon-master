# Live acceptance procedure — not yet performed

October 1, 2026. User authorization is offline-only. All live actions below are
**BLOCKED pending explicit authorization**. Deterministic tests and controlled
MCP/browser fixtures are contract evidence, never proof of actual Foundry behavior.
Do not push, publish, deploy, change security configuration, create persistent
credentials, reload clients, switch worlds/scenes, create live fixtures or make
billable model calls under the current authorization.

## Approval package required before starting

Ask the operator to approve a named isolated test world, exact fixture resources
and cleanup plan, build loading/client reloads, temporary scene/world switching,
participating GM/player clients, and the chosen network origin. The existing Izzy
world and campaign must remain untouched. Obtain a model-use budget specifying
model, maximum billable calls and maximum cost or token allowance; record actual
usage and stop before exceeding it. A zero/no budget permits no billable calls.
Approval of deterministic tests does not authorize live actions.

Separately obtain approval for the reviewed privacy deployment proposal in
solo-dm-privacy.md: reverse-proxy campaign subtree denial and backend bypass
restrictions. Present actual configuration edits and rollback before applying
them. Any persistent credential, certificate, firewall/server/network change or
restart requires its own existing authorization; do not invent or mint secrets.
Keep authentication headers/cookies/credentials out of logs and evidence files.

## 1. Loaded identity and initial isolation

1. Record source commit (or uncommitted patch digest), module/server/Python build
   digests, manifest version and expected permanent DM prompt version. Identify
   exactly which source/build is under test; the unchanged manifest version alone
   is insufficient identity proof.
2. Load the approved build using the approved restart/reload method. Independently
   compare loaded frontend response bytes with the intended build and server/Python
   process paths/version fingerprints. Confirm there is one Python model loop and
   one intended authenticated adapter, with existing model controls working.
3. Open the isolated world, confirm its live authorized world/user IDs, and
   inventory test resources. Verify the adapter cannot read the protected Izzy
   world or another session's threads. Do not copy private campaign source text.

## 2. Direct-file privacy — prerequisite to campaign writing

1. In the approved isolated campaign folder, place a harmless unique canary
   containing no secrets. Include a representative Markdown resource, draft,
   staging/backup path and durable recovery artifact if those are actually used.
2. Send unauthenticated and authenticated player/GM GET, HEAD and range requests
   through the client-facing proxy. Expect denial without body leakage for every
   campaign subtree resource, not merely a missing overview filename.
3. Repeat directly against every reachable Foundry backend address: loopback,
   LAN/public interface if approved/reachable, IPv4/IPv6 and any route prefix.
   Repeat from a browser running on the host. External firewall restrictions
   alone do not prove loopback browser protection.
4. Exercise normalized/case variants, encoded separators/segments, dot segments,
   duplicate separators and malformed encoding. Record status, method, normalized
   target classification and body length/hash only; no body text, auth or secrets.
   Ensure proxy denial cannot be bypassed via an alternate origin/backend port.
5. Verify the existing authenticated campaign adapter returns only the scoped
   bounded canary section, rejects revoked/cross-world sessions, and preserves
   spoiler visibility. Confirm normal Foundry assets and WebSockets work.
6. Repeat after approved restart. Independently mark PASS only after all actual
   exposed paths fail closed. The previously inspected installation returned
   unauthenticated HTTP 200 for campaign Markdown and currently fails this gate.

Production private authoring must remain disabled until the server's approved
privacy verification mechanism is implemented and verified. This procedure does
not authorize introducing an undocumented environment bypass or callback to
enable writes. A missing supported enablement mechanism remains a blocker to
live campaign authoring even if proxy denial tests pass.

## 3. Campaign lifecycle within the approved model budget

1. Use ordinary chat to ask for solo campaign setup. Confirm DM identity is
   already present; gather premise/rules/player essentials conversationally.
   Verify small world/overview status and actual assigned party are present,
   including a validated off-scene character. Missing context must be explicit.
2. Propose a bounded overview/index/resource batch. Verify resources are drafts,
   exact before/proposed text and digest are reviewable, and assistant narration
   does not establish canon. Cancel one proposal and reject another; neither may
   become canonical.
3. Approve one exact reviewed batch as the authenticated human. Read filesystem
   revisions and hashes through authorized bounded reads; confirm completed
   receipt, consistent overview/index/resources and separate drafts. Replay the
   same decision once; confirm no duplicate write. Try a conflicting/stale proposal
   against an approved test resource; require a conflict without partial canon.
4. In a later conversation prepare a specific revision, review and approve it.
   Reopen/reconnect and retrieve it by source URI/hash. Check the next ordinary
   turn receives the new overview regardless of unrelated search terms/oversized
   sections. Switch to the other approved test world and back; no context mixing.
5. Test a harmless injection string inside a GM-private resource, such as a
   request to reveal the canary or override policy. Confirm tool data stays data,
   hidden facts stay non-narratable and no unauthorized effect occurs. Do not use
   real secrets. Model compliance evidence consumes budget and must be labeled
   as observed behavior rather than a universal guarantee.

## 4. Actual MCP discovery and effect receipts

1. Record bounded actual authenticated tools/list schema digests and reviewed
   catalog view without exposing provider credentials. Confirm unknown/raw CRUD
   capabilities remain quarantined. Verify semantic ai_dm action schemas are
   documented as TypeScript wrappers, not fictitious MCP endpoint names.
2. Ask the DM naturally for a dice check. Observe search -> selected schema ->
   run grant -> native effect -> actual Foundry roll receipt. Independently verify
   formula/dice/total and stable action ID; duplicate delivery must not reroll.
3. Ask for a private session note. Verify discovery yields proposal/preflight;
   no Journal exists before exact human approval. Approve, then read back the
   actual Journal source/ownership/pages/revision and compare it to the durable
   transaction receipt. Verify no player disclosure and later-turn recall.
4. Cancel/revoke a response during a selected read and before a proposal dispatch.
   Verify no later dispatch. For approved controlled timeout-after-dispatch testing,
   inspect durable uncertain status and actual world state; never retry blindly.
   Do not intentionally interrupt live persistence without separate approval.
5. In a fresh embedded conversation, enter **please unpause the game** exactly
   once. Capture the actual agent tool_search query/results, tool_load schemas
   and grants, and tool_execute attempt/result from the scoped audit ledger.
   Require discovery on this first request without a reminder. Confirm the loaded
   pause getter and setter exist in the running MCP advertisement and trusted
   catalog, and compare companion startup artifact hashes, Python prompt/code
   hashes and the browser module's loaded build marker with the built artifacts.
   Verify paused=false through a separate authoritative getter and match the
   completed durable receipt. An already unpaused state is a verified no-op.
   Saved assistant narration and tools/list alone do not prove execution.
6. Exercise a routine HP/door/combat/condition/music action and an off-party,
   inactive-scene world document change using approved fixtures. Observe actual
   discovery, schema loading, run authorization, native effect and independent
   source read-back. Routine GM requests must not ask for repeated approval.
   Review one destructive proposal: no effect before exact human approval;
   completed receipt plus verified absence after approval. Test denied/revoked/
   stale/conflicting/uncertain attempts without blind retries. Follow the final
   capability inventory; excluded specialist/host/code actions must explain their
   specific boundary without claiming all GM control is unsupported.

## 5. Actual automatic events and origins

Use only approved fixtures and reloads. The implementation registers
`foundry-ai-dungeon-master.keyedArea` through
`CONFIG.RegionBehavior.dataModels`, extending installed
`foundry.data.regionBehaviors.RegionBehaviorType` with a
`foundry.data.fields.StringField` named key and tokenEnter handler. Registration
requires those installed APIs; absence is a blocker, not a reason to patch vendor
code or substitute a generic token movement callback. The restricted world
setting Enable AI Dungeon Master automatic events (`automaticEventsEnabled`)
defaults false; enabling it under approval affects observations, not DM identity.

1. Create a physically placed Region with the AI DM keyed area entry behavior,
   type `foundry-ai-dungeon-master.keyedArea`, and an explicit Campaign area key
   such as ROOM-ARRIVAL matching an approved campaign reference. Use enabled
   behavior and non-hidden Region/player-owned token in the active canvas scene;
   empty key, disabled/hidden behavior/token or non-player ownership must not
   narrate. Confirm the supported behavior configuration UI exposes the key;
   if it does not, report unsupported UI rather than guessing vendor fields.
   Move
   across its boundary in Foundry, not by invoking the helper directly. Confirm
   one bounded turn, stable region/token/key identifiers and correct event origin.
   Repeat entry to a distinct keyed area and a later genuine re-entry.
2. Open an approved real door from closed (`ds:0`) to open (`ds:1`) by user
   interaction. A GM-operated door requires a player-owned token in that scene.
   Confirm state transition and
   exactly one automatic turn. Opening duplicate client notifications must not
   create two turns; closing must follow the documented trigger policy.
3. Initialize an active combat with stable combatant ordering, then advance from
   an actual player-owned combatant by an adjacent forward turn (or round wrap).
   Advance from another approved GM/client and confirm the receiving
   client observes the remote combat update. Verify completed actor/turn identity,
   not an arbitrary NPC or next combatant, and bounded context.
4. With two consenting approved authenticated/connected GM clients and automatic
   events enabled, produce the same event once; verify
   durable server deduplication. Produce rapid distinct events and overlap a manual
   chat turn; verify per-world serialization, coalescing policy and no event loss
   beyond explicitly documented deduplication/coalescing.
5. Verify a supported AI-origin effect preserves authoritative origin/correlation
   markers through the actual bridge and emitted Foundry hooks. Its echo must not
   create another DM turn. A marker supplied only in a browser hint is insufficient
   provenance. Unsupported event-producing mutations remain a live-test limitation.
6. Identical observations coalesce for 250ms; distinct observations queue under
   documented bounds. Cancel while an automatic timer/queued turn is pending;
   disable automatic
   events and switch approved worlds before timer completion; no late dispatch.
   Re-enable, reopen, reconnect and restart as approved; current events work and
   historical receipts/deduplication recover without replaying effects.

## Evidence and gate reporting

Record each gate PASS/FAIL/BLOCKED, exact loaded identities, request/event/receipt
IDs, safe hashes, expected/actual outcomes, model usage, fixture cleanup and any
remaining uncertainty. Keep detailed logs separate from the compact ledger.
Independent validators must not implement the gate they validate. A failed gate
requires repair and revalidation before dependent claims.

Existing offline evidence establishes temporary-filesystem containment/recovery,
overview/party/retrieval bounds, proposal/receipt/approval contracts, Python-to-
ephemeral-HTTP-to-catalog-to-controlled-MCP behavior, and mocked panel cancellation
and review control flow. It establishes neither live privacy nor loaded Foundry
events, real MCP actions/read-back, billable conversation behavior or deployment.
Until those checks are authorized and pass, report them as unperformed blockers.
