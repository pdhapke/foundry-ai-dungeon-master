# Active-world GM document control

Ordinary authenticated GM text binds a server-held manual-request authority to that turn. There is no English verb whitelist for world document operations. Automatic events, quoted resources, prior narration and model tool arguments cannot mint this authority. Known parsed routine requests retain their exact value constraints. A narration snapshot remains deliberately small; it does not limit a GM's separate active-world read entitlement.

The reviewed manifest covers 21 document families and five CRUD operations per family. A semantic definition is admitted only when the exact original provider schema and the typed world-document bridge schemas are actually advertised. Original provider mutations remain quarantined. Search and schema loading issue world/user/thread-bound grants; execution verifies grant, live GM authorization and schema digest before dispatch. Every outside descriptor has a named reason in the generated capability inventory. Specialized game methods outside CRUD still require their own reviewed adapter; host, credentials, code execution and other-world operations are separate scopes.

Typed operations use world/family/parent/target scope, a bounded source and a SHA-256 revision. Canonical source hashing sorts keys with binary comparison recursively and omits `_stats` at every depth. Review hashing includes the exact before state, complete request, scope and server-selected target. All parent IDs are checked at initial read, preflight, mutation receipt and independent readback. Root paths and approval flags are never accepted from the model. Raw sources are untrusted and not automatically narratable; credential-shaped fields are removed from model-facing projections.

Each mutation claims a world/user/thread/action ID in SQLite before dispatch. Replays with the same frozen request return its stored result, conflicting input is refused, and uncertain results are not retried. Ordinary resource creation and updates use the current GM request once. Deletion, ownership changes and embedded collection replacement create durable pending proposals, then require a separate exact authenticated browser review. Proposal execution only prepares this review; it cannot approve it. Browser approval is a conditional transition on the complete persisted entry. Code-bearing behavior and executable content require a separate restricted executor and remain denied even after generic document review.

The typed backend checks the expected revision immediately before Foundry document mutation. Core asynchronous document updates are not an atomic compare-and-set against simultaneous human edits. Completion therefore requires a scoped correlated backend receipt, independent authoritative readback and matching requested fields; mismatches or lost responses are uncertain. The direct getter, apply receipt and second getter must agree on source hash and parent scope.

World-file tools are wired through the separately validated `ChatKitWorldFileActions` adapter and the `worldFiles` read-tool option. The adapter receives only trusted server roots and run scope. Delete/recovery actions use exact browser review; deployment privacy remains a separate fail-closed gate.

Automatic mutation suppression recognizes only exact `foundry-local-api.transaction`, `foundry-local-api.session-action` and `foundry-local-api.world-document` producer markers. Region suppression additionally requires the actual core movement object identity, movement ID, token/world/scene/destination/revision and correlation match. Lookalike source prefixes and model observation hints carry no authority.

## Verification

- Ten focused world policy/service/proposal tests pass, including a joined first ordinary turn search → load → session execute → durable verified world update, off-scene GM reads, no narration authority, exact deletion approval, revocation, replay, uncertainty, executable data rejection, parent isolation and cross-language canonical ordering.
- Server typecheck, module typecheck, scoped lint and all workspace builds pass. Module 40 tests pass with mocked Foundry APIs.
- Final broad server run passes 225/225. Its earlier world-file recovery exact-review budget regression was repaired and independently validated by that adapter owner. Detailed test output is in solo-dm-world-control-test.log.

These are deterministic fixtures and contract evidence. No model compliance, loaded Foundry build, actual remote mutation/origin roundtrip, audibility, physical Region behavior or deployment privacy is inferred from them. Those require the parent-approved isolated live acceptance gates. No live requests, reloads, world changes, credentials or campaign resource edits were performed by this implementation.

