# Independent capability validation

**Final expanded offline gate: PASS. Live embedded-chat/Foundry acceptance: BLOCKED and unperformed.** Final AI tests: 286 PASS (7 bootstrap, 9 shared, 230 server, 40 module); Python: 26 PASS. Full AI lint/typecheck/build/manifest PASS. Related full tests and final affected backend tests/typechecks/build/scoped lint PASS. Detailed evidence is in [expanded evidence](solo-dm-expanded-evidence.md).

October 1, 2026. Validator did not implement the routine action, catalog or backend changes. Scope is source, installed core source and deterministic fixtures only. No billable model calls, live mutations, reloads, fixtures, credentials or network/configuration changes were authorized or performed.

## Initial gate: FAIL

Focused AI tests: six PASS, one independent test process FAIL. Importing `ChatKitSessionActions` directly raises `ReferenceError: Cannot access 'SESSION_SEMANTIC_TOOLS' before initialization` in `catalog-tools.ts:96`. The cycle runs through `session-actions` → `read-tools` → `catalog-tools` → `session-actions`. Existing fixture import order conceals the problem. Independent regression: `server/src/chatkit/session-actions.independent.test.ts`.

Focused local API tests: four PASS, one independent FAIL. Installed core `App/client/documents/actor.mjs:547` treats `CONFIG.statusEffects` as a keyed record. New backend assumes an array and calls `.some`, producing `TypeError: effects?.some is not a function`. Independent regression: related module `module/src/commands/session-actions.independent.test.ts`.

The same installed Actor method destructures only `{active, overlay}` and dispatches ActiveEffect create/delete without supplied origin/correlation options. The backend's arbitrary extra toggle options cannot carry provenance into those actual mutations. Repair the trusted narrow effect path or quarantine conditions; mocked toggle fixtures currently accept unsupported options.

The adapter accepts any changed combat state as successful advancement (`!equal(after, before)`). A receipt and separate read-back can agree on an invalid successor; the independent regression supplies round99/turn99. Exact successor/order evidence is required before claiming this receipt completed. Backend currently verifies its own computed successor, but independent adapter validation must not reduce that check to mere change.

## Positive evidence and boundaries

Existing tests exercise seven fake MCP write/read-back sequences through trusted discovery, schema loading, session grant execution, durable SQLite receipts and replay. Default session denial, exact human value/target binding, schema drift, revocation, cancellation and uncertain-result no retry checks pass. These are useful contract checks, not actual embedded chat or live Foundry evidence.

Installed `playlist-sound.mjs:145/172` supports playing/pausedTime semantics and `sound.currentTime` is present. Document read-back does not prove audible playback.

Installed `token.mjs:2831/2846` passes the same `operation._movement[token.id]` object into tokenEnter. The added origin cache requires exact object identity plus scene/world, revision and destination, appropriately avoiding inferred trust from arbitrary correlation prefixes. Movement remains quarantined until independent deterministic and approved live gates.

Backend expected-state comparison happens at dispatch, but Foundry's asynchronous document update is not an atomic compare-and-set. Documentation correctly names this limitation. Synthetic actors are resolved from current-scene token actors and duplicate same-ID distinct actor objects fail closed; the current actor-ID-only schema cannot separately select identical-base-ID synthetic actors. Full GM world management is pending, and exact direct-request syntax is a current implementation boundary rather than a permanent GM permission model.

Live loaded build identity, actual embedded agent discovery trace, actual mutation/read-back, remote hook propagation and audio remain BLOCKED by offline scope. Read-only runtime advertisement never proves executable capability coverage. Integration is not complete.

## AI repair gate: PASS

The cycle was removed by extracting the bounded-call helper. Direct service import now succeeds. Exact combat successor validation rejects the independent round99/turn99 receipt plus matching read-back. Four focused tests pass, including the independent regression and routine discovery/execution suite. Backend condition/turn-count repair awaits its separate gate.

## WorldFiles independent gate: FAIL

Five existing real-filesystem/SQLite tests pass: scoped authored writes and receipts, traversal/ADS/reserved names/junction rejection, privacy/revocation, concurrency/interruption recovery, and separate destructive grants. An independent injected SQLite recovery-receipt insertion failure leaves the original operation `recovered` with its journal cleared rather than `pending`. The recovery finalization UPDATE and INSERT are separate statements; interruption between them can lose recoverable state and the durable recovery receipt. `server/src/chatkit/world-files.independent.test.ts` proves the failure with actual temporary files and SQLite. Finalize both ledger changes in one transaction and revalidate before wiring.

## WorldFiles repair gate: PASS

Recovery finalization now wraps the original-row update and new receipt insertion in `BEGIN IMMEDIATE`/COMMIT with rollback. The unchanged independent fault regression passes and preserves the pending journal. Combined AI session and WorldFiles suites: ten PASS. Temporary filesystem tests exercise actual files, junctions and SQLite rather than mocked storage. Administrative ancestor replacement races cannot be eliminated by this Node Windows implementation and remain explicitly documented.

## Backend repair gate: PASS

Six focused backend tests pass. Two independent tests verify record-shaped configured status data and actual narrow command create/delete calls through a configured status factory, marker forwarding and separate authoritative-command read-back. The backend follows the installed status factory path rather than passing unsupported options to toggleStatusEffect. Combat state now includes turnCount; adapter successor verification can check wrapping exactly. Source and mock contract evidence do not prove the loaded browser's actual execution.

## Manual GM world-role request gate: PASS (source/fixtures)

Two parser tests pass: ordinary manual requests derive a digest-bound world role without an English verb whitelist; automatic, retry and quote-only requests do not. Gateway verifies live GM authorization before deriving this request authority. This is a role signal to reviewed typed adapters, not filesystem-root authority, unrestricted MCP or destructive review. Validation of each consumer's scope and destructive controls remains required. Interim server typecheck was BLOCKED by the pending `SessionRequestAuthorization.worldControl` declaration; rerun after integration.

The source build identity marker added to the module is offline-only. It is not evidence that the running Foundry page loaded these bytes; compare authenticated runtime markers and build hashes in the separately approved live gate.

## World-document backend gate: FAIL → repaired PASS

Independent installed-core inspection found `executeScript` Region behaviors execute `system.source` as JavaScript, while `executeMacro` behaviors resolve and execute `system.uuid`. The initial property-name filter admitted these real nested shapes after destructive review. `module/src/commands/world-documents.independent.test.ts` independently reproduced the bypass through a valid scene-regions parent/family and required zero mutation calls. The repaired backend explicitly rejects these executable behavior types and existing executable behavior updates. Five focused backend tests pass, including this unchanged regression; independent-test lint passes. Document provenance uses a new source marker that requires the corresponding trigger mapping gate.

The backend source-hash comparator initially differed from the AI adapter comparator for mixed-case nested source keys. Source hash interoperability remains a dependent gate until the adapter comparator and actual backend-to-adapter contract are verified.

## WorldFileActions and UI review gate: PASS

Seven adapter tests pass using real temporary files and SQLite, including an independent actual service-review → browser-validator contract. The independent test checks exact before-state digest binding, refuses substituted content and another GM scope, and leaves the file untouched. Other fixtures cover routine writes, exact separately reviewed deletion/recovery, durable replay, cancellation/revocation, uncertain writes and privacy default denial. Campaign canon paths remain routed through campaign proposal controls. Adapter and UI review digest ordering now use deterministic binary ordering.

The panel renders before-state and exact request with `textContent`; no returned HTML executes. Scope, closed-panel/thread and generation guards prevent stale async review buttons from authorizing another context. UI review test and module typecheck pass; AI server typecheck passes after integration. These are source/contract gates; panel behavior in actual Foundry remains a live acceptance gate.

## World-document interoperability gate: PASS / embedded-list repair pending

An independent contract invokes the actual local-api command implementation behind the actual AI document adapter, using mocked Foundry documents and SQLite. Mixed-case and Unicode source keys hash consistently after the binary-comparator repair. Ordinary update executes and separately reads back; delete remains pending until the actual UI review validator accepts the exact digest and a browser approval arrives, then verifies absence. This proves execution-path code rather than only read access, while remaining a mock-Foundry contract, not embedded-chat acceptance.

The adapter now rejects an embedded receipt with the correct ID/hash but the wrong parent. The same new parent binding exposed a regression: actual backend embedded-list responses omit parentId, so legitimate `foundry_list_actor_items` fails `World read scope mismatch`. The independent contract includes this actual backend list and stays FAIL pending repair. Full world-document gate is held until it passes.

Production authorization now independently checks active-world source, requested User document and live `get_user_status` activity rather than expecting the activity flag in User.toObject(). The provider explicitly returns `{userId, active}`; its userId should also bind the activity result to the requested identity. No live authorization call was used as proof.

## Embedded-list and completed-review repair gate: PASS

Backend list responses and shared contract now include parentId for embedded families. The actual backend → adapter → UI independent contract passes the embedded actor-item list, source hash, ordinary write/read-back, pending deletion review, approved deletion/absence, and completed review display. A separate wrong-parent same-ID/hash regression passes. Both repositories' server/module typechecks and independent-test lint pass. Production authorization now also binds `get_user_status.userId` to the requesting identity.

## Recovery review transport gate: FAIL

An additional independent real-filesystem/SQLite/UI test interrupts an accepted 7000-byte → 7000-byte overwrite. Both request and files fit the declared bounds. Recovery proposal generation succeeds, but the complete browser validator rejects the review because the journal duplicates content as original request plus before/after base64 and the total envelope exceeds 24k. At 12k old/new files the journal can exceed the adapter's own 32k recovery ceiling. The accepted operation cannot reliably reach its supported exact recovery UI. `world-file-actions.independent.test.ts` keeps this regression failing until transport/component budgets or compact exact recovery evidence are aligned. Document reviews have the same total-envelope issue when combining bounded before/request/receipt components; no review may silently truncate exact changes.

## Recovery/receipt transport repair gate: PASS

Nine real-filesystem/SQLite adapter tests now pass, including the unchanged independent 7k overwrite review regression and a maximum 12k overwrite, actual database close/reopen, exact browser review and successful recovery. Browser-only complete review is bounded at 96k; model views omit duplicated journal/content and preserve digest/revision/status metadata. Model discovery arguments remain bounded at 12k and results at 24k. The world-document independent backend fixture now contains approximately 15k source data: update returns a compact completed model receipt below 24k, while exact browser review retains before/source/receipt data and remains displayable after completion. A near-24k document source may still exceed the total model response envelope; this returns explicit unavailable instead of silently truncating or granting broader access. Effective readable source size is the 24k total minus transport metadata.

## Final aggregate interim evidence

Full AI deterministic tests PASS (bootstrap 7, shared 9, complete server suite, module 40). Full related-module tests PASS (bootstrap 18 and all shared/server/module suites, final module 271). Configured ChatKit virtualenv Python tests: 26 PASS. Invoking system Python instead lacks installed dependencies; that is an environment invocation failure, not a feature regression. Related typecheck/build and scoped new-feature lint PASS. AI manifest PASS. AI typecheck/build ran during active pause-policy repair and exposed transient undefined authority/arity errors; final frozen revalidation is required. AI full lint found 26 errors across that transient pause repair, inspection-script Node globals, file-adapter tests and one JSON.parse unsafe return. Gate remains held until repairs and final checks pass.

## Additional private-proposal persistence gate: repair pending

Root identified that FileActions could persist raw private request/before content in SQLite before the underlying WorldFiles privacy gate rejected filesystem mutation. Operational proposals/journals must be protected too. Final acceptance is held for early private-storage verification before proposal persistence and independent database inspection proving missing/denied gate leaves no private-content rows. This requires no configuration changes; private persistence stays disabled by default.

## Private-proposal and final aggregate repair gate: PASS

An independent actual SQLite test proves missing and denied private-storage callbacks leave both proposal and operation tables with zero rows. The adapter checks the trusted privacy callback, live authentication and cancellation before private proposal creation and immediately before insertion; pending browser decisions require the same private-persistence gate. A further independent test delays each privacy checkpoint1–6, including final pre-effect authorization, until cancellation, then releases it and proves no late actual filesystem write. WorldFiles reauthorizes after the private callback, preventing aborted or revoked work from resuming. The full final AI run includes these tests and passes286 tests (server230). Full lint/typecheck/build/manifest pass after the frozen repair. Configured Python26 and related full-suite checks remain valid; final affected related backend5 and all-workspace typecheck pass. No live privacy state changed.

## Inventory gate: PASS (source/historical snapshot)

Independent data checks confirm273 unique records, complete input schemas/effects/dispositions/reasons, all disposition counts summing273, source246core+27optional, historical256 runtime names, zero runtime-only names and17 source-only names. Source-only names comprise4 new session/world bridges plus13 inactive optional Trails tools. Covered/equivalent/internal132 plus excluded/quarantined141 reconcile to273. Generic known-family CRUD admission is separate from specialized methods and unsupported data fields. Executable code remains excluded even after ordinary destructive review and needs a separate restricted executor; GM world settings/Users/packs/assets gaps are adapter gaps, not denial of the GM role. Inventory cannot prove the running build executes the newly added bridges.
