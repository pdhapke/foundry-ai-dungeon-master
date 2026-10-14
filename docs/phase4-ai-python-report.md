# Phase 4 AI/Python integration evidence

## Starting inventory and ownership

Read root REPOSITORY.md and inspected current source before editing. Existing dirty/untracked work is inventoried in phase4-start-ai-inventory.txt and preserved. This worker owns AI server/shared/Python/frontend integration only; native MCP/dnd5e implementation belongs to the context worker. No services, inference, fixtures, or live mutations are authorized for this offline implementation turn.

## Current observations

- ChatKitAttackActions already durably claims stable scoped action IDs for one attack roll or a separate persisted damage application. Scope includes world/user/thread; source identifiers and read-back are validated; unresolved attacks fence fresh IDs. These are source observations, not new live acceptance.
- Python exposes read_attack_state, roll_attack and apply_attack_damage; durable call/result pairs precede immediate factual receipt messages. Its installed-SDK continuation and Phase3 permanent mutation fence remain in place.
- No bounded multiattack sequence/resume integration exists at this starting point. The routine narration boundary cannot release combat compound workflows.
- Native adapter has a 10-second per-operation bound and Python HTTP adapter a 12-second bound. The sequence contract must account for those limits or introduce an explicitly bounded sequence-only adjustment.

## Contract and gates

Initial prerequisite: the native sequence/resume ledger contract was agreed before wiring production integration. Requested: explicit actor/item/activity/target IDs; stable action and per-step IDs; bounded steps/targets/time; structured roll and damage evidence; explicit resource before/after verification; per-step durable outcomes; stopped/partial/uncertain decisions; validated continuation without rerolling or double consumption. AI integration must validate receipt identity and scope rather than reproduce system rules.

Independent validator is assigned to installed-SDK durability/replay/cancellation/next-turn and scoped gateway integration. Offline and live gates are distinct. Existing full Python baseline is 80 PASS; all later checks will report regressions separately.

## Implementation and focused validation

The settled native contract is attack-sequence-v1: execute an explicit 1..4-step immutable plan or resume an exact clean deadline ticket. Native state retains the original sequenceRequestId, cumulative plan/steps, completedStepCount, and nullable continuation. Children derive SHA256(JSON.stringify([origin,stepId,phase])). AI server exposes authenticated native_attack_sequence and review/direct attack-sequence operations through the existing mutation authority architecture. No combat workflow releases the Phase3 world slot early.

ChatKitAttackSequences persists scoped dispatch claims before native calls. Retry with the same ID returns the stored result; changed arguments conflict; a pending crash or uncertain outcome fences fresh IDs. Resume requires the prior partial receipt and exact ticket in the same world/user/thread. Receipt validation requires outer identity, immutable plan/origin, cumulative step source/action/IDs, real completed rolls, consistent miss evidence, applied HP/temp-HP deltas, nonempty verified resource arrays and exact spend, and mutation flags. Previously completed prefix receipts remain byte-equivalent under canonical serialization; only new children use the current correlation ID. Native code remains responsible for rules and current continuation observations.

Python exposes typed execute/resume tools and generates immediate factual step summaries distinguishing damage rolled from applied and completed from unresolved work. Resource changes are summarized only from verified native evidence. Durable SDK call/result pairs and factual receipt messages precede ordinary continuation. Requested prose cannot delay those receipt events; combat still uses ordinary continuation and never qualifies for routine one-request finalization or narration-only release.

Focused Python suite: 3 PASS, including actual installed-SDK durable exchange, immediate receipt event, SQLite reopen, complete next-turn protocol, and retained combat mutation scope. Gateway focused suite initially 3 PASS; independent review found five malformed-evidence cases accepted. Repaired all five; combined own3/independent6 PASS9. Added pending-crash/isolation coverage afterward. Full-suite captures are phase4-python-all-tests.txt and phase4-ai-server-all-tests.txt; Python final fullsuite: 88 PASS in 42.292 seconds. Server final fullsuite: 283 PASS in 10.552 seconds after additional consistency/pending-crash/resume coverage. Server typecheck and server-only build PASS after repairs.

## Frontend repair blocker

An avoidable encoding error in this worker's attempted frontend edit opened/truncated application.ts before failing to encode a new Unicode arrow under Windows default cp1252. The prior dirty source was not replaced from HEAD. All frontend writes/builds stopped immediately; the current compiled artifact was preserved. The orchestrator is recovering exact typed source from task-related evidence. Latest pre-edit TSX transformed code is preserved as phase4-recovered-application-transform.txt for fallback verification, not described as original TypeScript. Frontend sequence review integration remains unfinished until recovery and independent checks complete. No runtime artifact was changed by the failed write.

## Remaining gates

Native resource/rules correctness, safe partial resume under current-state drift, reactions and unsupported automation are separately validated by the native worker and independent validator. Genuine choices/reactions and uncertain/pending outcomes do not get automatic continuation. Explicit GM-authorized sequences do not establish Multiattack entitlement or action economy. Bounds are admission checks between awaited stages; in-flight native work cannot be forcibly cancelled. Live embedded natural-language and player-view acceptance require separately approved inference/fixtures and the user's manual loaded-build update. No server lifecycle or paid inference occurred here.


Final focused gateway coverage is 11 PASS (own5 plus independent6): same-ID replay/conflict/revocation, lost acknowledgements/source drift/fresh-ID fencing, cross-conversation resume rejection, pending crash claim/isolation, and successful clean deadline resume with immutable cumulative prefix, original child IDs and original prefix correlation. Additional receipt checks reconcile critical evidence when exposed and typed damage-roll totals against damageRolled. Independent Python tests cover cancelled post-effect delivery with SQLite reopen, old narration-run denial before HTTP, and actual temp-HP applied damage distinct from rolled damage. Full Python test85 initial run failed only the existing expected tool-name set after adding two tools; updated expected set and final88 PASS. No baseline failure remains.

The orchestrator directed this worker to omit new frontend sequence features while recovery proceeds. Current ChatKit factual receipts expose mechanics immediately; clean resume is exposed through the typed tool and authenticated direct/review API, without pretending player reaction tickets can be resolved by a model. Frontend recovery is a separate gate owned by the context worker. Production source is not live acceptance, and no inference budget is requested or spent by this worker.


Prepared Python app SHA256: 119e9125b9f9cd78e8fa52f88e5b87b18a5ba3a8022ac8f10c2451aa395e6f63. New server/dist/chatkit/attack-sequences.js must be included in the orchestrator's prepared build manifest alongside changed attack-actions/native-actions compiled files. This worker did not update runtime build identity or restart services. Final independent signoff requested after the frozen final artifacts; frontend recovery/browser/live acceptance remain separate.
