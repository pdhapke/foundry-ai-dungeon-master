# Prompt 2 resume independent offline gate

Validation date: 2026-10-04. This gate uses fixtures only; it makes no campaign publication, model requests, runtime restarts, or live Foundry mutations. Implementation files were read-only to the validator.

## Focused evidence

Command from `server`: `node --import tsx --test src/preparation-jobs/resume-independent.test.ts src/preparation/publication-review.test.ts src/preparation/source-inventory.test.ts src/preparation-jobs/durable-native.test.ts`.

Result: 19/19 passing at the initial integrated gate. Seven independent regressions cover:

- Persisted preparation package ID cannot accept replacement content/digest.
- Completed composition rechecks embedded token existence; deletion cannot retain successful readiness.
- Full bounded source records preserve qualifications, private facts, and matching packet manifests, without confirmation/publication.
- Source replacement after hashing cannot change public imported bytes: import uses the reviewed buffer.
- Stale source hash, other-world input, and revoked asset authority cannot write public fixture assets.
- Native transport uses existing scoped world-document CAS/idempotent primitives and separate readback; replay avoids a second create.
- Forged native readback world/identity fails closed.

Worker tests independently executed in the same command cover interrupted embedded writes, durable claims, inactive/source/review gates, exact browser publication authority, human/canonical/source drift, receipt recovery after committed-files/interrupted-SQL completion, source injection as data, section budgets, deterministic packets, inventory snapshot refresh/cursors, and scoped source reads.

Review findings delivered to implementation owners: persisted-package digest binding, saved-token receipt readback, and avoiding source reopen between approved hashing and public asset writing. All three pass independent regressions after fixes.

## Limits and pending checks

This gate does not establish live player/TV secrecy, real map/grid visual acceptance, publication approval, full-corpus simultaneous publication, or model preparation quality. Native readiness deliberately excludes visibility, trap mechanics, and live acceptance.

The initial subsequent server no-emit typecheck caught an integration exact-optional-property mismatch in `preparation-service.ts` inventory options. The owner fixed it; the integrated AI server no-emit typecheck passes.

Existing source-review drafts remain private under the runtime preparation-drafts directory; source inventory tests and this gate do not publish them. No shared build outputs were regenerated.

## Integrated production-route follow-up

Added `server/src/preparation-service-independent.test.ts`: four independent tests pass. They verify an aborted earlier request does not poison cached source inventory, authorization revocation denies cached access, bounded complete records stage privately without overview/index or public campaign copies, source drift rejects preparation, DM requests cannot grant publication/import approval, a valid native package needs exact browser review, and changed/cancelled job revisions reject the old package. Native apply with an absent package fails closed; the composer/transport regressions independently cover approved execution fixtures.

The combined service/transport follow-up command passed 13/13 before the fourth service fixture was added; the final service-only run passed 4/4. AI server and MCP server no-emit typechecks pass.

Actual MCP endpoint Zod conversion to advertised JSON schema includes strict `preparationGuard` with `sceneId` and `preparationId`. MCP module guard fixture passes 1/1. MCP module no-emit typecheck currently reports three preparationGuard type errors because package imports resolve old shared/dist declarations. Its source shared interface contains the new field. Deployment owner must rebuild shared declarations before the module check/bundle; validator performed no builds.

Final integrated focused run: 27/27 passing across service-independent, native-independent, file-store, durable-native, queue, publication-review and source-inventory suites. AI server no-emit typecheck passes. File job storage now claims exclusively before compare-and-swap; a real two-child-process race has exactly one writer. Uncertain/crashed claims fail closed rather than being silently deleted. Queue calibration requires explicit zero origins; the legacy fixture now supplies them.

The owner added repeated authoritative job revision/cancellation fences to composer authority and transport authorization. A new actual service/MCP-await fixture passes: suspend the client's world-document read promise, cancel the authoritative SQLite job while it is pending, release the response, and assert zero subsequent native mutation calls. Service independent suite now passes 5/5.

Production jobs use `SqlitePreparationJobStore`; legacy JSON import is read-only and happens once. Independently executed SQLite suite passes 3/3, including separate-connection CAS/reopen and an actual child process exit during an uncommitted transaction. This removes filesystem orphan-claim recovery from the production path; the claimed file store remains an offline compatibility implementation.

## Complete-corpus referenced staging follow-up

`server/src/preparation/records-independent.test.ts` passes 2/2; AI server no-emit typecheck passes. The test prepares 60 complete source-document fixtures, composes 62 records whose inline JSON exceeds 128 KB, stages/loads the compact referenced candidate, paginates review at 20 records, rejects DM confirmation, confirms and publishes only inside isolated temporary fixtures, and preserves all existing detail records during incremental composition. A manual edit to the next candidate's readable record blocks publication while preserving the active version.

The second test interrupts staging after a real durable record batch. The candidate remains undiscoverable until all referenced records are durable; exact replay resumes the batches and yields all 62 records without publication. No real campaign sources or canonical files are changed by these tests.

Independent-owned tests now comprise eight native/asset/inventory regressions, five service regressions, and two complete-corpus staging/publication regressions. Live acceptance remains outside this offline gate.

Final merged offline gate: **34/34 passing**, 23.0 seconds, running the independent service/native/records files together with SQLite/file-store, durable-native, native queue, publication-review, and source-inventory tests. Final read-only private-storage sanity check confirms actual selected-world `overview.md` and `index.md` remain absent, and full-source v3 candidate/inventory and six review packet directories remain under private runtime preparation-drafts. Fixture publication did not publish real campaign drafts.

## Cache, interview provenance and Foundry v14 follow-up

The new integrated cache/interview gate passes 12/12 (nine service tests and three helper/serialization tests). It checks current authenticated source URI/hash/spans, cached retrieval after the earlier request's signal is aborted, typed record revisions with unknown IDs returning null, manual readable-record edits invalidating cached retrieval, and revocation denying cached inventory.

Interview tests preserve literal Unicode answers in GM-only private sources, reject byte overflow, invalid modes/answer fields, cross-world/session mismatches, and out-of-order revisions. Equal revision replay is idempotent; equal revision with changed content conflicts. User/session identity scopes generate distinct immutable source and watermark paths.

Actual service fixtures prepare from a partially answered interview, confirm the draft, then update an answer. The old confirmed candidate cannot publish because its watermark hash is stale. A separate fixture publishes the interview-backed source inside temporary storage, obtains typed record hashes, creates a planning job, updates interview intent, and verifies resume fails on stale source provenance.

Two defects found and fixed during this gate: Zod enum-key record accidentally required all six interview answers (replaced with partialRecord); record parsing stripped source trailing newlines (now removes only exact serialization framing). Independent regression tests retain both cases.

Separate source-composition test passes: explicit same-world links resolve across independently staged packets, external/cross-world/path-escape references remain unknown, case-insensitive alias collisions are removed and flagged for review, and authored Unicode aliases retain metadata-line provenance. No entity identity is creatively inferred.

Foundry v14 native bridge fixture passes 1/1: native Scene Level defaults are accepted while the supplied level IDs, count, background and texture fields remain verified. This is fixture/source evidence, not live acceptance. Shared declaration/bundle generation remains deployment-owned.

Latest merged independent gate: **46/46 passing**, 22.6 seconds, including the cache/interview, alias/link and v14 follow-ups together with all prior focused fixtures. AI server no-emit typecheck passes. Validator changed only independent tests and this evidence document; no runtime actions, generated build outputs, model calls or real campaign publication occurred.
