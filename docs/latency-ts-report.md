# Latency investigation: TypeScript instrumentation

2026-10-02. Phase 3 queue changes remain paused. No optimization, inference request, setting/cap change, runtime fixture mutation, service start/stop/restart, or client reload was performed.

## Step 1: loaded baseline

Read-only AI DM health observation: ready; startup 2026-10-02T15:42:31.108Z; manifest f3a828c9f0c7c274180217d5512040363aaf3cab72ea50d3d38f38f6134dc234. Loaded read-tools hash 13299a2a389ff5e7470cbc804244156643043084cbfb9a8fee54271475eed58d and routine-completion hash 027f7ce0304f2625fc30934af49b65ff2390d9a9e163657ab00bacab529eee0a matched the prepared prior artifacts. Thus prior speed work was loaded at this observation; the newly added latency health field was absent. New instrumentation requires manual restart and loaded artifact verification. These observations do not establish measured command latency.

Both module Git inventories were inspected before editing; substantial existing dirty/untracked work was preserved. No AGENTS.md was found under the modules. Repository runtime ownership instructions remain in effect.

## Ownership and trace contract

Owned AI Node changes: server latency-trace helper/tests; gateway; read-tools; MCP integration client; core-actions; campaign overview tracing; startup identity/app health/index; offline export script and this report. Python and AI frontend are owned by the completion worker.

Owned MCP changes: server latency-trace helper/tests; startup identity/app health/index; endpoint registry and mutation lane; bridge Foundry client; shared diagnostic envelope/types; module bridge client, opt-in timed command registry and session action spans; native marker generation script/build command/generated marker.

Gateway accepts only UUID correlation x-ai-dm-trace and generates one otherwise. It applies to embedded and direct /actions paths. Existing authenticated loopback x-chatkit-trace ties Python requests to the Node run. Internal adapter correlation comes from the actual bound run, not a supplied principal. AsyncLocalStorage preserves parallel-call separation. MCP tool-call _meta carries diagnostic foundry-ai-dungeon-master/trace-id. Native BridgeRequest carries diagnostic traceId, never authority.

## Measurements prepared

Durable AI Node events cover request/queue entry and exit; queue wait; authorization/credential boundaries; every context catalog/read/auth operation; serialization/budget validation; overview cache validation/hit/miss; adapter operation; MCP catalog/tool roundtrip; execution/readback acknowledgement; SQLite receipt persistence; response delivery.

Durable MCP events cover endpoint execution, native mutation queue wait, bridge dispatch/ack roundtrip and native execution duration. Native opt-in session actions report preflight read, authoritative readback and mutation-and-readback durations. The encompassing mutation span overlaps its readback span; these are not additive. Native dispatch duration includes native queue/command handling, so it is not mislabeled as mutation time. Roll and pause native command totals remain coarse where no inner stage instrumentation exists.

Native timing records carry performance.now start/end and a document-scoped UUID clockId shared with the AI frontend probe. Browser submit to native start/end can be calculated only if the exact clockId matches. Different browser documents or processes must use separate measured durations/receipt-arrival bounds. Wall timestamps are not subtracted. Node rows also include processRunId and monotonicMs; elapsedMs is scope-relative and must not be subtracted across scopes. Never add overlapping preparation spans.

Node sinks write bounded asynchronous JSONL: queue 512; batched writes; two approximately 4MiB files. The sink projects strict safe fields; request text, arguments, target names, content and credentials are omitted. Native inner stage names are allowlisted. Telemetry errors cannot redispatch or reject mechanics. Health exposes dropped/errors and retention so missing evidence cannot be mistaken for complete tracing. Failure accounting includes an in-flight batch. Rotation means evidence must be exported promptly and include .1.

## Readout and loaded identity

AI file: configured runtimeRoot/ai-dungeon-master/latency-traces.jsonl. MCP file: server/.runtime/latency-traces.jsonl. Python file is beside its configured database. The frontend worker supplies browser diagnostic export. Offline readout: `node scripts/export-latency-traces.mjs <explicit files> --trace <UUID>`. It groups safe rows by correlation and retains originating clocks; it never computes a false cross-process timeline or sums overlapping spans.

AI startup identity includes the new server trace helper and campaign implementation. MCP health build captures compiled server index/app/trace/registry/bridge/lane, shared protocol and native bundle/marker artifact hashes once at process initialization. Module build generates LATENCY_BUILD SHA256 from native instrumentation inputs; actual native acknowledgements carry that embedded marker. After a manual restart and intended-client refresh, compare MCP startup artifact hashes with prepared artifacts and native loaded marker with the generated source marker. A version string or current disk hash alone does not prove loaded identity.

## Offline validation

AI focused tests: 17 passed, 0 failed; docs/latency-ts-tests.log. MCP focused tests: 29 passed, 0 failed; MCP docs/latency-ts-tests.log. Includes durable sink projection/concurrent contexts/failure behavior, gateway pause, core action checks, endpoint MCP registration, native session actions, legacy command dispatcher and client reload scheduler compatibility. Shared build and both MCP server/module typechecks passed during implementation; orchestrator owns final all-module checks/build and prepared manifest after all workers finish.

Independent validator reported targeted sink/browser/Python checks and performs final propagation/native stage checks separately. Fake tests establish instrumentation correctness and synthetic overhead only. No live latency bottleneck or speed improvement is claimed. Benchmark remains pending explicit bounded inference approval, manual restart/loaded identity verification and reversible fixture setup.

Final-suite repair: the first full MCP run found an instrumentation regression when legacy SDK callback mocks omitted the extra argument. Both registry callbacks now use optional extra metadata access. The focused registry/integration repair run passed 12 tests (MCP docs/latency-registry-repair-tests.log); the orchestrator repeats the full MCP gate. This failure was introduced by instrumentation, not classified as a baseline failure.
