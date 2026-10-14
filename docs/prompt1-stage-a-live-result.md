# Stage A bounded live result — stopped after first stream failure

2026-10-04 UTC. Exactly one approved user prompt submitted once through the authenticated actual GM panel gateway, pinned to cold-named fixture/thread/trace in the approved proposal. This is not a true-cold trial. Existing ChatGPT-plan OAuth and gpt-5.6-sol unchanged; zero retries/resubmissions/fallbacks, no maintenance or generation. Second prompt and >60-second idle comparison NOT RUN after first failure.

Full pre-dispatch independent admission:22770/24576 conservative input units. Actual dispatch context-prepared trace:22817/24576 (wrapper/converter representation differs); reserve8192 and effective output cap1024 unchanged. All30 tools retained. Actual provider-billed input/output token usage and plan remaining allowance are unavailable from these retained artifacts. One model-request and one provider stream invocation, one consumed durable allowance; no failed provider retry or second request. The provider completed a tool call successfully, so count this one usage-consuming call despite final stream failure.

Outcome: foundry_set_door_state confirmed exact fixture door RsB12oN5v3LYI1XR open in scene2RJeJKqdpEE4VZPh. Complete tool-call/result pair durably stored, along with user message and displayed assistant receipt 'Door opened.' HTTP200 stream then emitted stream.error/allow_retry=true. That generic retry hint does not override the approved no-retry stop rule. No second allowance spent. Error cause assessment is in independent report; do not advertise this as a clean successful chat completion.

| Measurement | Duration / scope |
| --- | --- |
| Residual gateway credentials resolution |0.847ms, expiry cache hit |
| Python full context preparation |383.153ms, response scope72ccc01b-36b0-42d1-9f83-cb1106ead7dc |
| Model response |5153.833ms within same Python scope |
| Tool result |250.442ms within Python scope |
| Native core execution/readback acknowledgement |161.639ms within its Node operation scope |
| Confirmed action result |5958.257ms from Python response origin |
| Durable receipt commit |22.139ms, Python receipt span |
| Browser response headers |2020ms from submission, includes preparation/transport |
| Browser complete stream including trailing error |8179.5ms from submission |

Do not sum overlapping spans or subtract Node/Python elapsed origins. Separate browser receipt-arrival/render time was not captured; complete-stream duration is not that measurement. Preparation before submission and total background overhead are not separately measured in this one failed trial. No preparation benefit comparison, idle-boundary finding, subsecond natural-language claim or 2–3-second claim is established.

Restoration before cleanup restart: doorclosed/unlocked, fixtureinactive, original Sargauth active/viewed Nbj38PEdvw1zX1J9, viewport3625/4875/1, paused=true, original thr_74e3c7f8 and620x720 panel/menuclosed/drawerhidden. Independent supported MCP document reads and correlated actual GM client readiness acknowledgement confirm native restoration. Automatic eventsfalse; no canon changes/publication replay. Selected model unchanged.

Exact test-owned allowance line removed from server.env after verifying it still matched the installed private binding record. Approved graceful cleanup restart in same visiblemintty23132/window6424490 revoked the captured two-entry startup map; no kills/locks deleted or hidden launches. New AI startup16:19:37.666UTC matches74/74,MCP17/17,Pythoncurrentv9normal15. Empty config reload means no temporary test allowance is carried forward; ordinary authenticated GM account capabilities remain unchanged. Durable consumed ledger is evidence, not a new grant. No statement that an old trace alone is globally forbidden on ordinary routes is made.

Remaining user action: cleanup restart leaves no active game session. Peter must launch izzy-campaign/rejoin as GM; this was reported immediately. Original native scene/door state was independently verified before restart; browser panel/viewport must be rechecked after rejoin if further restoration verification is requested. Do not infer post-restart loaded-player state without reconnect. Manual speed feedback remains open; test stopped and unused allowance must not be spent without a new approved scenario.

Evidence in .runtime/foundry-ai-dungeon-master:stage-a-first-result.json,stage-a-first-traces.json,stage-a-full-input-admission-independent.json,stage-a-actual-initial-context.json,stage-a-restored.json,stage-a-restored-independent.json; visible terminal capture prompt2-evidence/stage-a-cleanup-current.png. Independent reports:prompt1-stage-a-first-result-independent.md,prompt1-stage-a-full-input-independent.md. All private transcript and receipt evidence retained; no transcript compaction/deletion.
