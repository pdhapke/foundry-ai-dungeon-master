# Approved bounded live prompt drafts

Only the orchestrator submits these two prompts. Current approval: current GPT5.6sol/ChatGPT plan, maximum three model requests per prompt and six total, no retries. These drafts request mechanics and factual summaries, no DM narration.

## Prompt 1

Run exactly two attacks in one bounded sequence from token 4Jgz4kpyTaMpkdHn, actor 7Omg3czrr0z94iw4, using item v6aPlCpfDEZdyhvB activity AttackFixture001 against token z2oFZhuQdL4GQ793 in scene xj5praphJhGr6mxL. Use normal advantage for both, roll each attack and apply its recorded damage on a hit. Use sequence action ID phase4-live-sequence-one and step IDs first and second. Stop on any choice, reaction, failure or uncertainty; never repeat a completed step. Report the confirmed rolls, damage rolled versus applied, and HP changes concisely. No narration.

## Prompt 2

Run exactly one resource-consuming attack in a bounded sequence from token 4Jgz4kpyTaMpkdHn, actor 7Omg3czrr0z94iw4, using item xfCubW10VwZVTVSI activity AttackFixture001 against token z2oFZhuQdL4GQ793 in scene xj5praphJhGr6mxL. Use normal advantage. Use the native activity's configured one-charge consumption, verify the actual resource change, roll the attack, and apply only its recorded damage on a hit. Use sequence action ID phase4-live-resource-two and step ID resource-first. Stop on any choice, reaction, failure or uncertainty; never consume or roll twice. Report the confirmed resource change, roll, damage rolled versus applied, and HP changes concisely. No narration.

## Tool shape and counting

Installed tool foundry_attack_sequence requires action_id, steps, max_duration_ms (8000). Each step requires step_id, scene_id, attacker_token_id, actor_id, item_id, activity_id, target_token_id, advantage, and nullable attack_mode/ammunition_id/ability_id. The adapter constructs native execute mode and enforces at most four unique steps. Resume requires an exact recorded clean deadline ticket; neither draft asks for an automatic retry or resume.

Count actual application calls from Python model-stream-invocation rows grouped by traceId/scopeId/request in .runtime/ai-dungeon-master/latency-traces.jsonl. Cross-check model-request hook rows, unique invocation indexes, transportRetryLimit0 and health/drop diagnostics. Provider response events occur multiple times per response and are not request counts. Baseline at 2026-10-02T21:49:07.820684Z:763 rows,203952bytes,6 stream invocations,6 hook rows; SQLite13 threads/104items (historical totals). Capture per-trial trace IDs and count their rows, with file offsets/rotation considered; do not merely subtract unrelated global totals. Unknown/missing telemetry does not grant unused budget.

Durable chat history is .runtime/ai-dungeon-master/chatkit.sqlite; read with SQLite mode=ro. Native AI sequence claims/receipts are in operations.sqlite. Browser Export latency diagnostics downloads ai-dm-browser-latency.json (numbered Downloads copies may exist); it contains trace IDs, document clocks, arrival timings/drop counters. Actual rendered receipts require separate browser observation. Never subtract unsynchronized process clocks.


Post-restart resource fixture: xfCubW10VwZVTVSI (AttackFixture001), verified by native retest. Prompt1 remains unchanged; prompt2 changed only its item ID. No embedded prompt has been submitted by this worker.
