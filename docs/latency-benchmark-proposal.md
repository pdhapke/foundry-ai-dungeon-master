# Proposed bounded latency benchmark — awaiting approval

No inference is authorized by this proposal. Phase3 stays paused; this measures the existing ordered execution path.

## Fixed conditions

Use the existing disposable core fixture only after fresh read-only verification of exact IDs, world, actor, door and originals. Same instrumented loaded build, intended opted-in GM client, dnd5e version, GPT-5.6-Sol, reasoning configuration and ChatGPT plan authorization throughout. API fallback stays disabled. Automatic events stay at their current disabled value; no setting change is authorized. Record effective configuration and complete prepared/startup identities.

Actions: open fixture door from closed, and set fixture actor regular HP from20 to18. HP is justified by the slower previous observation but that observation does not establish its bottleneck. Both paths use the same authenticated execution service and authoritative readback. Direct shortcuts are `/ai-control door <scene> <door> open` and `/ai-control hp <scene> <actor> 18`; equivalent embedded forms use explicit IDs with fixed wording. No narration, attacks, or model comparison.

## Counts and allowance

For each action: one first-use direct/embedded pair, then two warmed pairs. Total **six embedded prompts and six direct shortcuts**, plus model-free fixture setup/reset/restoration. Maximum **six application-level model requests**, **zero provider retries**, **zero prompt resubmissions**. Proposed temporary `AI_DM_CHATKIT_MAX_TURNS=1` requires explicit approval and manual restart/load verification; restore prior disk setting afterward and disclose the running cap until another user-managed restart. Stop on any uncertainty, count/trace gap, auth failure, unexpected continuation, or additional automatic inference. Existing source provider retry setting is0 and must be verified loaded. No extra submissions use an unused allowance.

Use existing ChatGPT plan authorization only; monetary unit cost is unavailable from current provider eligibility and account allowance consumption is uncertain. Six requests consume that allowance. No API provider, service tier or credentials will be substituted. User approval must explicitly cover this count/cap and temporary test limit before requests/config changes.

## Comparable state/context

Restore doorclosed/HP20 before each observation. Keep party/scene/combat/overview configuration constant and capture relevant revisions. Reset via authenticated model-free native calls, never by cached authority. Use a fresh empty conversation for each embedded trial so accumulating conversation history does not change context; repeated exact prompt and initial context/schema digests must match or explain differences. The first-use pair is recorded separately from two repetitions; alternate pair order afterward to expose ordering effects. Record that provider cold/warm cache state is unknown unless actually reported.

## Timing interpretation

Browser elapsed submit→receipt-arrival uses one browser monotonic clock. Submit→visible receipt is an actual DOM/render observation on that clock with sampling bounds; SSE completion/rAF alone is not proof of paint. Confirmed native readback is correlated by trace ID; report browser action-complete evidence separately from exact native readback spans, without subtracting browser/server wall clocks. Node queue/context, Python model/store, MCP/native execution each report local monotonic durations. Correlated stages establish ordering; transport segments across clocks remain approximate unless bounded with same-clock request/response spans. Preserve raw events and explicitly mark missing spans.

Record actual application-level request counts, retry configuration and observed retry events, provider IDs when exposed, actionable arguments ready, tool/readback/ack, receipt creation vs completed commit vs emit vs browser receipt, and receipt-only final output. No separate narration is measured because none is requested. Do not infer tails or reliable percentiles from three trials per action/path. Do not compare old mixed-command item timestamps with these measured trials as a before/after baseline.

## Cleanup and gates

Capture original active scene/pause/combat and exact fixture values before setup. Restore them after testing, leave fixture inactive, independently read back originals, and verify browser view/pause. Keep reversible trace evidence, but restore approved temporary settings. No process lifecycle operation occurs during cleanup; user handles any needed restart. Benchmark validation checks outcomes, trace/clock definitions, actual request evidence or explicit limits, and restoration. Choose a small bottleneck change only after reviewing these traces. Additional comparable post-change inference requires a new explicit approval.

## Manual loading steps after approval

After explicit benchmark/cap approval, the orchestrator prepares only the approved temporary one-turn setting and records its prior value. Then save play, return Foundry to Setup if needed, shut it down normally, start it with the usual launcher, reopen the intended world and join as the test GM. Tell the orchestrator the restart is complete; it independently compares AI/MCP health startup hashes with latency-prepared-build.json, Python code digest/maxModelTurns1, trace loss counters and native marker. Server restart is never performed by the agent. This is necessary because new Node/Python instrumentation is not loaded by a browser refresh.

For the intended connected opted-in test client only, discovered reload schema is `foundry_reload_client({clientId?,userId?,correlationId,delayMs?,minimumModuleVersion?})`; target exact verified identity with unique correlation ID. Scheduling acknowledgement is not reconnection proof. Verify `foundry_get_client_readiness` and native embedded marker afterward, then check model/auth readiness with zero-inference Refresh status. Do not reload unrelated clients or alter automatic-event settings. A frontend refresh cannot replace server restart.
