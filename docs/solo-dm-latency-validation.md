# Independent solo DM latency validation

2026-10-01. **PASS for source call accounting; qualifications below.** Independently traced the source rather than accepting the analysis totals. No live model calls, benchmarks, configuration changes, or implementation changes. This report is the only file written by this validator. No applicable AGENTS.md was found in the workspace or module.

## Recount

Scope: successful changed-state pause/resume, one search, two loads, one granted pause read, one granted setter; campaign enabled and active scene. N means actor records inspected (0–16), including candidates that may not become party members. C means non-empty upstream chunks forwarded by the gateway, not tokens or SSE events.

| Segment | Authorization groups | State tool calls | tools/list calls |
| --- | ---: | ---: | ---: |
| Gateway ingress and after ordered-turn entry | 2 | 0 | 0 |
| Initial context | 12+2N | 5+N | 1 |
| Search and two loads | 6 | 0 | 3 |
| Granted pause read | 6 | 1 | 3 |
| Granted changed-state setter | 14 | 4 | 4 |
| Stream forwarding | C | 0 | 0 |

Each authorization group invokes three MCP tools in parallel (`server/src/index.ts`, `authorizeChatKit`). Therefore the total is **130+7N+3C MCP tool calls plus 11 tools/list calls**. At N=4: **158+3C tool calls plus 11 lists**. These exclude transport initialization, session authentication internals, retries/recovery, additional model-selected tools, and provider-side implementation work.

The setter's eight internal authorization checks are: entry, initial read, before durable claim, second read, schema-verification boundary, setter call, post-read, final release. Four catalog invocation checks and two session-authorization checks bring its total to fourteen. Its four state calls are two pre-reads, explicit setter, and post-read. The standalone granted read adds two pause-adapter checks to four catalog checks.

Evidence: `server/src/chatkit/read-tools.ts` (context builder and serial actor loop), `catalog-tools.ts` (entry/invoke/return checks and provider snapshot), `server/src/tool-catalog/runtime.ts` (`executeGrant` refresh and session boundary), `native-actions.ts` (pause authorization), and `pause-actions.ts` (read/request).

## Streaming and model claims

**PASS:** `server/src/chatkit/gateway.ts` checks live authorization after each non-empty `reader.read()` and before `response.write()`. The next read waits for this check and any response drain. This is a serial forwarding cost of C authorization groups / 3C MCP tool calls. Upstream buffering may coalesce chunks, so C is dynamic and cannot be equated with generated tokens. The model can continue producing output upstream while forwarding waits.

**Qualified PASS:** `chatkit-server/dm_prompt.py` prescribes search → load schemas → read observed state → setter → final response. A compliant changed-state execution needs at least five sequential model decision rounds if the loads share a round; a fully serial two-load sequence needs six. This is an inference from tool-output dependencies, not a runtime-enforced trace or measured model-request count. Extra decisions/failures can add rounds; no-op requests omit the setter. `app.py` uses one Runner with max_turns=8 and disables OpenAI retries. It does not prove every actual response follows the prompt.

Avoid calling the non-chunk total a “pre-stream base”: initial context precedes Runner, but tool work and model output can interleave with stream events. The total is a whole-turn source count excluding chunk authorizations.

## Limits and recommendation checks

- PASS: discovery limits are four searches, six definitions, twelve executions, and twenty-two adapter discovery operations. General/native/campaign/file adapter operations share `run.calls <=12`; context actor reads do not each consume this run-level budget.
- PASS: Node operations use shared abort deadlines, normally ten seconds; gateway run timeout defaults to five minutes. The stream check and header timeouts are separate boundaries. These settings cannot be multiplied by call counts to predict elapsed time.
- Correction: Python `httpx.AsyncClient(timeout=12.0)` sets HTTP phase/inactivity timeouts; it is not an explicit twelve-second wall-clock deadline for the whole adapter request. Each call creates a fresh client, confirming the pool-reuse opportunity.
- Qualification: without an active scene, context still runs `party([])` and can inspect assigned party actors. Campaign-enabled no-scene context costs 2+N state calls, 6+2N authorization groups, and one list; without campaign/active scene there are only two state reads and six authorization groups, with no party reads in that branch.
- PASS as proposals: measuring queue/context/auth/catalog/model/dispatch/forwarding separately, removing duplicate catalog refresh while preserving drift checks, reducing irrelevant context for trusted explicit intent, pooling HTTP connections, and bounding storage reads are supported by source structure. No latency benefit has been measured.
- Authorization optimization requires a documented freshness guarantee. In-flight coalescing alone is not proven equivalent to current checks; an epoch design requires reliable revocation events and dispatch/release tests. An atomic provider snapshot is a proposed capability, not an existing source capability.
- Preserve durable action IDs, insert-only claims, exact argument checks, expected state, immediate dispatch authorization/schema verification, post-read, cancellation and uncertain-result handling. Parallel context reads require equivalent scope and release checks; deterministic control routing requires trusted explicit ingress intent.

Conclusion: the principal numerical findings are correct for the stated path. They establish many network requests and serial boundaries, not the cause or duration of the reported latency. Use whole-turn totals, inspected-actor N, conditional model-round counts, and HTTP phase-timeout wording when presenting the findings.
