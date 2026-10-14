# Pause experiment ledger

Date: October 1, 2026 (America/Chicago).
Scope: pause/unpause only; mandatory user manual checkpoint before expansion.

## Starting state
Both modules contain extensive preexisting modified and untracked files. No ancestor or module AGENTS.md found in initial scan. MCP location verified: C:/dev/FoundryVtt/Data/Data/modules/foundry-local-api. Preserve existing work; no Git reset, remote changes, push, deployment, or live model budget assumed.

## Phase and ownership
Phase 1: inspect current embedded path and baseline; Phase 2 narrowly repair/implement pause experiment.
- ai_pause: AI module implementation and focused tests, excluding independent validation files.
- mcp_pause: MCP module pause implementation and focused tests.
- validator: independent starting-state capture, independent tests and validation report.
- parent: this ledger and manual checkpoint documentation.

## Contract
Workers inspect existing interfaces and agree a typed explicit desired pause state before changes. Reuse existing Python loop and authenticated TypeScript/MCP services. Execution-time GM/world authorization, ordered state changes, idempotency, confirmed/uncertain outcomes and origin propagation are required.

## Baseline evidence
Historical docs/solo-dm-latency-live.md claims UI 47s unpause and 38s pause, audited adapter spans 18.372s/16.265s, with discovery, schema loads and redundant reads. These are historical evidence awaiting independent assessment, not fresh runs or budget authorization. Current live/model timing remains unmeasured until manual test unless independently recoverable read-only.

## Gate / next step
Phase 1 and Phase 2 gates pending independent validation. No approved new live model budget. Prepare build/reload instructions, evidence locations, and short manual checkpoint; then STOP for explicit user feedback and approval.

## Frozen narrow contract
New MCP tool: foundry_set_game_paused_confirmed.
Input: strict {paused, worldId, userId, requestId, correlationId, origin: "ai-dm"}.
Output: {outcome: "confirmed" | "uncertain" | "failure", paused: boolean | null, worldId, correlationId, mutated, message?}.
Identifiers are bound by the authenticated execution service, not selected by the model. Confirmation represents canonical GM game.paused read-back, not every connected client acknowledgement. Legacy capabilities stay available.

## Baseline gate refinement
Historical timing claims are secondary evidence; complete current action/narration and stage timings require a manual run. No measured speedup will be claimed from offline tests. Validator will distinguish instrumentation/source readiness from live baseline acceptance.

## Final gates and evidence
Phase 1 source trace/preservation capture PASS; complete measured current live baseline BLOCKED pending manual test (no new model budget).
Phase 2 independent source/unit gate PASS; live embedded correctness/performance BLOCKED pending user test.
AI full initial test run: 7 bootstrap + 9 shared + 230 server + 40 module PASS; Python 26 PASS. Final focused hooks/identity/core checks and build/typecheck PASS. Validator independent core3 + hook1 PASS. MCP initial full run PASS; final full run had unrelated playlists worker failure without assertion detail, isolated playlists rerun PASS. Independent MCP pause6 PASS; build/typecheck PASS. Test lint has no errors; MCP independent fake tests retain any warnings.
Validation: docs/pause-experiment-validation.md. Preservation manifests and read-only live identity: docs/pause-experiment-evidence/. MCP logs: pause-experiment-build.log, pause-experiment-typecheck.log, pause-experiment-tests.log, pause-experiment-playlists-recheck.log in MCP module root.

## Final contract additions / limitations
Receipt adds optional stateObservedAtMs (canonical GM browser epoch timestamp). Browser pause observations and action notification issuance carry correlation; these never enqueue an inference turn and do not prove pixel paint. Browser and Node loaded policy is pause-experiment-v1; Python prompt solo-dm-v7-pause-experiment. Keep existing world inference queue (explicit ordering). Short recognized requests use bounded overview; paraphrases retain core tool but may incur full context. No slash shortcut.

## Next step — mandatory STOP
Deliver docs/pause-experiment-checkpoint.md. No new live model calls or game mutations, deployment/restart/push, or additional command families. Wait for user manual cold/warm/reconnect results and explicit approval to continue. Offline success or elapsed time is not approval.
