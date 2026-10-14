# Phase 4 handoff

Bounded combat acceptance PASS for the reviewed explicit attack-sequence and finite item-use workflows. Five approved model-free sequence deliveries and exactly two embedded natural-language prompts were delivered; the latter used four actual application-level model requests, zero retries and zero resubmissions through the existing GPT-5.6-Sol ChatGPT plan authorization. No extra requests used the remaining headroom. API fallback remained disabled. HTTP provider request IDs/billing counts were unavailable and are not inferred from response events.

## Completed and validated

Explicit 1–4-step native dnd5e sequences use stable IDs, per-step durable outcomes, authoritative resource/HP readback, exact duplicate protection and validated clean between-step resume. Installed dnd5e6.0.3 executes rolls and damage; no replacement rules engine or inferred Multiattack/action-economy entitlement. AI validates structured evidence and stores complete call/result exchanges plus immediate factual receipts. Both live prompts ran in the same embedded conversation, proving subsequent-turn continuity and rendered correctness.

Native first two-step sequence: rolls12/16, damage5+6, target40HP/temp4→33/temp0, client RPC359.44ms; duplicate13.08ms with identical receipt/state. Initial resource case consumed one charge, then stopped uncertain before any roll because Foundry expanded dotted update keys inside ledger evidence. No retry occurred. User-approved hash-pinned reconciliation changed only two pending booleans/audit fields, preserving historical uncertain results. Minimal repair stores update paths as string values. Repaired resource test: roll12, damage6,40HP/temp4→38/temp0, spent0→1/3, RPC655.03ms; duplicate27.97ms unchanged. These are individual client RPC observations, not native execution distributions or equivalent before/after samples.

Embedded two-step request: rolls22/18, damage7+5,40HP/temp4→32/temp0. Embedded resource request after reset: roll20, damage7,40HP/temp4→37/temp0, spent0→1/3 verified. Both complete native receipts and factual summaries matched browser rendering and independent current-state readback.

Offline baseline full AI362/MCP922/Python88 tests plus typechecks/builds passed. The subsequent resource repair passed targeted17 and full modified native-module329 tests, typecheck/build, independent actual-Foundry-expansion11 and AI semantic11. All45 final prepared hashes match the loaded build. Independent final restoration/readback and durable conversation gates PASS. Production source was frozen after final artifacts; no source-only claim substitutes these scoped live results.

## Latency observations

| Observation | Two-step embedded | Resource embedded |
| --- | ---: | ---: |
| Browser submission to receipt arrival | 12.00s | 8.59s |
| Browser submission to stream completion | 16.86s | 12.64s |
| Actual rendered receipt observation upper bound | 17.18s | 16.60s |
| Context preparation (Python roundtrip) | 1.16s | 0.70s |
| First model response | 9.14s | 6.23s |
| Native adapter roundtrip including auth/readback | 0.66s | 0.72s |
| Receipt persistence commit | 0.020s | 0.012s |
| Final factual-summary model response | 4.87s | 4.06s |

One sample per distinct prompt, no controlled cold/warm experiment and no reliable percentile or speed-improvement claim. First model response dominates these observations; context/catalog remains measurable, queue wait8–9ms and receipt commits are smaller. Actual action-confirmation and exact paint timestamps were not separately exposed. Render upper bounds use a separate observer clock and include orchestration gaps; no unsynchronized clock subtraction. Context subspans overlap and cannot be summed. No DM narration was requested. Complete definitions/raw evidence are in phase4-live-python-report.md and phase4-live-final-browser-latency.json.

## Limitations and remaining work

Support covers reviewed item/activity use resources and explicit plans. Unsupported activation/linked/spell resources, effects, complex automation and genuine reactions/choices stop explicitly. Deadlines are admission checks between native stages; no hard cancellation of in-flight native operations or atomicity claim. Clean partial resume/cancellation/crash/revocation/conflicting-control cases have offline coverage; this small live sample does not prove every rule or interruption mode. Player perception expansion and optional model comparison were not started. Speed remains deferred and the roughly2–3s aspiration was not demonstrated.

A worker's encoding error earlier truncated dirty application.ts. The pre-edit compiled bundle was preserved; TypeScript declarations/comments were reconstructed, with independent full runtime equivalence, typecheck and frontend63 tests passing. Exact original typed bytes were not recovered. An existing asynchronous hash-event ordering assumption was repaired in a test only; automatic-event behavior/settings were unchanged.

## Restoration and manual step

Fresh original active scene, pause/combat, actor/target HP/temp and token positions are restored. Newly created resource fixtures removed; automatic events remain OFF as before. Audit receipts/reconciled historical uncertainty and the dedicated test conversation remain as evidence. No pending entries remain. No services were started/stopped/restarted by agents; foreground test scripts exited and SDK clients closed. OS access denied system-wide process attribution, so no independent claim is made about unrelated user-managed processes; none were terminated.

Temporary cap3 is removed on disk, restoring the prior absent setting. The running Python process still has cap3 until the user restarts Foundry through the normal launcher; verify loaded default8 afterward without inference. No automatic lifecycle action is authorized. Ask for manual combat-response/speed feedback and stop here; broader phases require explicit direction.

Evidence: phase4-ledger.md; phase4-independent-final-handoff.json; phase4-independent-embedded-one.json; phase4-independent-embedded-two.json; phase4-independent-resource-retest.json; phase4-independent-reconciliation-verification.json; phase4-live-resource-retest-restoration.json; phase4-live-python-report.md; phase4-live-browser-observations.json; phase4-embedded-submission-ledger.json; phase4-live-cap-rollback.json.
