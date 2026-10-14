# Phase 3: campaign authoring and exact human review

Implementation evidence, October 1, 2026. This phase adds TypeScript authoring through the existing authenticated adapter and browser action endpoint. Python wrappers and panel rendering are separate owners. Deterministic fixtures use temporary directories and SQLite; no live campaign, model, configuration, credential, vendor code, or related module changes occurred.

## Frozen model adapter operations

- `campaign_read`: `{path, startLine?:1, endLine?:80}`. Only overview/index and one-level `locations/`, `npcs/`, `factions/`, `quests/`, `rules/`, `sessions/` Markdown resource paths. At most 80 lines and 8000 UTF-8 bytes per excerpt. Returns `status`, path, exact file revision/sourceHash, excerpt span, text, truncation, and an untrusted-data label. Missing files produce `status: missing`.
- `campaign_propose`: `{proposalId, title, files:[{path, expectedRevision:null|string, proposedText}]}`. IDs are bounded ASCII identifiers; expected revisions are null for absent files or exact lowercase SHA-256 of prior content. Strict schemas refuse approval flags and other authority fields. Total input is limited to 16000 serialized UTF-8 bytes, 32 files, and 120-character titles. Oversize exact review refuses with a split-proposal message. No model operation approves or commits canon.
- `campaign_proposals`: `{proposalId?}`. An exact ID returns its complete review; omission returns at most 12 scoped summaries with `reviewAvailable: false`. The browser must load the exact view before enabling approval. Conflicting reuse of an ID refuses; an exact repeated proposal returns its existing state.

All use the existing run token's world/user/thread binding, expiration, cancellation, 12-call budget, and live GM authorization. Caller filesystem roots, principals, grant flags, and raw MCP execution are never accepted. A new thread may only bind once through the authenticated sidecar. Canonical resource Markdown is data; metadata and references are parsed without execution.

## Frozen browser action contract

POST the existing authenticated `/chatkit/actions` endpoint:

```json
{"kind":"campaign","threadId":"thread"}
{"kind":"campaign","threadId":"thread","proposalId":"proposal"}
{"kind":"campaign","threadId":"thread","proposalId":"proposal","batchDigest":"64-lowercase-hex","decision":"approve"}
```

Decisions are `approve`, `reject`, or `cancel`. The HTTP envelope remains `{ok:true,result:...}`. Existing native dice/private-note bodies and responses remain compatible. Campaign browser decisions share the existing per-world inference queue through `ChatKitTurns.enterAction`; they do not resolve model credentials or call the model. Queue cancellation releases the reservation; replay ownership belongs to durable campaign proposal IDs rather than transport event IDs.

Exact result views include `kind: campaign`, schemaVersion 1, proposalId/title, immutable scope plus worldId/userId/threadId, batchDigest, expiresAt, files, status, transactionId, receipt, issue, approval, requiresConfirmation true, reviewAvailable true, and trust. Files include `path`, expectedRevision, beforeHash, afterHash, complete beforeText/proposedText, beforeCanonStatus, and afterCanonStatus. Initial additions have null beforeText/hash/status. Digest hashes stable JSON of schema version, scope, title, ordered full review files. An approval must send the digest of the exact view shown; different digest or scope fails. Render text with textContent, not innerHTML. Never hide reviewed files or substitute truncated previews for an approvable exact view.

Successful receipt includes `receiptId`, proposalId, batchDigest, `outcome: completed`, worldId, files with revision/sourceHash, and verifiedAt. Status must be completed and receipt outcome completed before reporting canon persisted. Drafting/pending/dispatching/uncertain statuses have no canonical success receipt. Duplicate approval returns the persisted same receipt without rewriting resources. Rejection/cancellation is terminal and writes no canonical files.

## Resources, drafts, consistency

Each canonical batch must explicitly review overview.md and index.md together with resources. Frontmatter matches Phase 2: schema_version 1, stable id, revision, visibility public/gm/secret, canon_status canon/draft. Canon targets require canon metadata; updates preserve IDs and advance metadata revisions. Duplicate IDs, noncanonical/broken index references, and unindexed proposed supporting resources refuse. Existing index references must be retained because resource deletion/unindexing is outside this MVP. Every referenced existing resource is read and validated against the same world; existing legacy resources require reviewed metadata migration rather than implicit rewriting. Izzy resources are unchanged.

The server stores separate `drafts/<server-transaction-id>/<ordinal>.md` copies with draft metadata before returning pending. The proposal's exact proposed canonical text remains immutable in scoped SQLite. These drafts are excluded from ordinary canonical retrieval. Initial setup therefore has durable material without establishing canon; later preparation is a new revision-bound exact proposal. Overview/index are committed as reviewed, never silently regenerated after approval.

Context refuses both overview and retrieval while the world campaign has an active write lock or outstanding rollback journal, with explicit unavailable status. That prevents partial batch contents from becoming narration. After approved writes, existing Phase 2 content-hash refresh yields the new overview and indexed resource sections.

## Durability and recovery

SQLite entries progress through drafting → pending → dispatching → completed, with rejected/cancelled/stale/uncertain alternatives. Proposal text is bounded and the global SQLite proposal budget is 5000; archival requires operator work, not silent deletion of referenced receipts. Approval records retain userId, exact batchDigest, and approvedAt. Conditional SQLite status update claims dispatch once before synchronous filesystem effects.

Independent validation found and repaired a cross-process decision race: every proposal transition now compares the exact prior persisted JSON and batch digest, including rejection/cancellation, stale marking, draft insertion/completion, dispatch claim/completion, and reconciliation. Lost transitions return the actual winning persisted entry rather than the stale local view. An active filesystem writer lock is observed without stealing its SQL state. Real second-process tests verify approval winning over rejection preserves its completed receipt, and rejection winning over approval prevents canonical dispatch.

Storage now accepts an optional server transactionId/batchDigest. A completed, read-back-verified batch writes a fsynced atomic `.receipt-<transaction>.json` marker before removing its rollback journal. Receipts contain the transaction/world/digest and each exact resulting content hash. Conflicting transaction replay refuses; exact replay returns the same marker without effects. Draft persistence has its own transaction and digest. Receipt markers are bounded to 16000 bytes and retained; their names and JSON are never public-security boundaries.

Authorized exact-proposal inspection reconciles drafting, dispatching, or uncertain states across restart. A draft marker makes a drafting entry pending. A canonical marker completes an approved entry with the receipt. An unfinished journal rolls back to its prior snapshot. Missing evidence remains uncertain and never redispatches automatically. If a surviving OS-process lock exists, recovery refuses until an operator confirms that writer stopped and clears the lock. A marker plus outstanding journal is validated against actual files before finalizing. Recovery itself is an authorized private write operation.

Live authorization is asynchronous; storage is synchronous. The adapter verifies actual world/GM before operations and before approval dispatch, then uses a ten-second immutable world/identity/cancellation lease for synchronous filesystem callbacks, and revalidates before exposing results. A server-side synchronous batch cannot process a new network revocation until its event loop resumes. Tests cover boundaries and revocation; they do not claim instantaneous revocation inside an uninterruptible synchronous operation. Cancellation after dispatch can leave a completed marker or an uncertain state; it never justifies retrying blindly or claiming rollback without evidence.

## Privacy and deployment

Production wiring supplies no private-storage verification callback. `campaign_propose` returns `status: storage_unavailable` with a clear reason before storing new sensitive proposal or draft content. Even an injected callback is checked before SQLite payload persistence and every storage mutation. No model/browser field can enable it. Existing Foundry static serving remains unchanged and live privacy is not claimed. Drafts, proposal database, journals, staging files, and receipt markers require the approved serving/storage privacy boundary, not merely Markdown filtering. Temporary fixture callbacks establish test isolation only.

## Evidence and limits

Server suite: 160 tests passed at the initial Phase 3 integration checkpoint. Focused authoring/storage/independent validation suites: 18 passed, including real process interruption/recovery. Server TypeScript check/build and focused lint passed. Subsequent final regression results are recorded in the phase ledger/validator report.

Authoring tests cover a scripted setup → pending draft → exact browser approval → verified canonical receipt → later preparation → refreshed recall sequence with no model calls; strict no-model-approval authority; SQLite restart at draft and completed-file checkpoints; real partial filesystem writes and rollback; duplicate/conflicting IDs/digests; stale/expired proposals; cancellation, rejection, authorization revocation, world/user/thread isolation; broken index references; interrupted context denial; authenticated adapter run scope; and manual-turn/action queue overlap/cancellation. Storage tests cover persistent marker replay/conflict and marker+journal recovery. Existing native-action, gateway, turn, context, and independent filesystem regressions remain applicable.

This is contract/real-filesystem evidence, not real conversational model behavior or Foundry runtime evidence. Python wrappers and exact panel review require their independent owners' validation. Live private persistence remains disabled. No real model-use budget or isolated live fixture approval was requested/consumed. Resource deletion, automatic legacy migration, invisible file changes, automatic uncertain retries, and live deployment are deliberately unavailable.
