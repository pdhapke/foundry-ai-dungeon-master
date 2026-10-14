# Phase4 embedded Python/store audit

Read-only audit against the post-restart baseline:6 historical actual model invocations and6 SDK hook rows;13 threads/104 items. No requests, fixtures, lifecycle or production changes were made by this worker. Current approval is exactly2 embedded prompts, maximum3 model requests per prompt/6total, no retries.

## Prompt1

Server/store gate PASS. Trace1513fce6-568c-4071-9ac9-1faa11bfeed0 contains exactly2 actual model-stream-invocation rows and2 SDK model-request hooks, request indexes1/2 in scope91b6626d-7891-41a9-8640-7c378c4891bc; final-response-finished is present. Complete durable tool-call/tool-result exchange:1. Deterministic factual receipt assistant item:1. Stored final factual summary:1. Conversation thr_74e3c7f8.

The exact requested2step plan completed with confirmed receipts: attacks22 and18, both hits; damage7rolled/7applied and5rolled/5applied. Applied damage includes absorbed temporary HP:40HP/4temp ->37/0 ->32/0. Resource item remains unconsumed by this ordinary weapon plan. No entitlement/action-economy guarantee is inferred.

Single Python scope measured model response durations9137.8ms and4871.2ms; native adapter roundtrip660.3ms; tool result to receipt commit55.2ms, of which store commit19.9ms; commit to stream enqueue4.5ms. These are process-local timings and do not prove rendered receipt visibility. The orchestrator separately observed rendered receipt at17.184s upper bound from its browser click clock, including observation delay. Browser export confirms receipt arrival11997.4ms, stream end16861.6ms, and ChatKit response-end16885.6ms in one document clock, with0 dropped/overbudget diagnostic events. No process-clock subtraction.

Budget used2/6 application requests. No unexpected inference trace observed. Provider response events are not counted as requests; transport request IDs are reported only when actually exposed. Metadata and owned-fixture durable evidence:phase4-live-prompt1-python-audit.json and phase4-live-prompt1-durable-audit.json.

## Prompt2

Server/store gate PASS. Trace7491cfa0-64e7-4e23-96d1-a3db7c481ae8 has exactly2 application model invocations (indexes1/2, scope cf60e514-9e80-4aa9-af92-9c9d3cff280e) and final-response-finished. Same conversation thr_74e3c7f8 retains one complete durable call/result exchange and one own deterministic factual receipt for this request. The exact fresh itemxfCubW10VwZVTVSI and one requested step completed: attack20/hit,7rolled/7applied,40HP/4temp ->37/0, resource spent0 ->1verified. Evidence:phase4-live-prompt2-python-audit.json. This also demonstrates subsequent conversation continuity after the first sequence.

## Joint latency evidence

One sample per distinct prompt, two samples total. First request followed manual restart; second used the same conversation after the orchestrator restored target HP/tempHP. No controlled cold/warm cache experiment was conducted. These are observations, not a distribution, model comparison or latency guarantee. Final factual summaries used a second model response; DM narration was not requested and no narration span is fabricated.

| Span (ms) | Two-step prompt | Resource prompt |
| --- | ---: | ---: |
| Node queue wait, reported duration | 8.0 | 9.3 |
| Python context preparation, reported duration | 1157.9 | 696.4 |
| Node catalog refresh, reported duration (within context) | 691.5 | 483.7 |
| Node context serialization, reported duration | 0.66 | 0.03 |
| First model response, reported duration | 9137.8 | 6231.1 |
| Model stream invocation -> tool start, same Python scope | 9152.6 | 6254.8 |
| Attack adapter operation, Node duration | 649.7 | 707.2 |
| Attack adapter roundtrip, Python duration | 660.3 | 718.4 |
| Tool result -> receipt commit, same Python scope | 55.2 | 41.0 |
| Receipt store commit, reported duration (within preceding span) | 19.9 | 11.9 |
| Commit -> receipt enqueue, same Python scope | 4.5 | 2.2 |
| Commit -> server receipt-event yield, same Python scope | 18.3 | 7.9 |
| Final factual-summary model response, reported duration | 4871.2 | 4059.7 |
| Browser submit -> receipt arrival, same document clock | 11997.4 | 8586.3 |
| Browser submit -> transport stream end | 16861.6 | 12637.4 |
| Browser submit -> ChatKit response-end event | 16885.6 | 12655.6 |
| Root actual-render observation upper bound (separate observation clock) | 17184.01 | 16600.6712 |

Browser evidence:phase4-live-final-browser-latency.json, with0 droppedRows/overBudgetEvents. Root observation upper bounds include orchestrator scheduling gaps; they are not exact paint times and cannot be subtracted from the exported document-clock timings. Receipt arrival is transport evidence; actual rendering is separately observed by the orchestrator. Native per-step exact confirmation timestamps and exact browser submit-to-action are unavailable in these AI/Python traces. Adapter readback roundtrip includes authorization/dispatch/native execution/readback; it is not pure native execution. Separate credential resolution duration is unavailable: only an elapsed marker without explicit scopeId/duration exists. No cross-process or unspecified-scope elapsed subtraction was used. Context subspans overlap their parent and must not be summed as independent totals.

## Counts and remaining gates

Exactly4 actual application model invocations total (2+2) against6 approved, with4 matching SDK model-request hooks, request indexes1/2 only and zero configured transport retries. No additional inference trace appeared beyond the two approved trace IDs. HTTP provider request IDs were unavailable; response-ID hashes are distinct response evidence, not provider HTTP request IDs or billing counts. No further prompt/retry is authorized by unused cap headroom.

Each submitted request has a complete durable tool exchange and immediate factual receipt; both native sequences are confirmed. Browser visible correctness and native fixture readbacks/restoration are independently owned by the orchestrator/context/validator. This report does not claim all dnd5e resources, effects, reactions, vision modes, true Multiattack entitlement, queue-overlap acceptance, or clean-partial resume were exercised live. No services/processes were started, stopped or restarted by this worker; no production configuration/source edits or live mutations occurred here.
