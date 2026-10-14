# Python/browser bottleneck analysis — read-only, 2026-10-02

Sources: first/warm1 embedded-door raw trace exports and C:/Users/peter/Downloads/ai-dm-browser-latency (1).json and (2).json. Two actual embedded observations; no distribution or universal warm/cold conclusion. Both used one application model request/stream invocation and confirmed the door action. No source/runtime/inference edits or requests were made for this analysis.

| Same-clock span (ms) | First | Warm1 |
|---|---:|---:|
| Model request → first provider event | 1933.6 | 3238.6 |
| First provider event → complete arguments | 1742.8 | 2230.9 |
| Complete arguments → response.completed | 55.9 | 84.9 |
| Complete arguments → SDK tool start | 183.7 | 310.5 |
| Model request → SDK model end | 3848.6 | 5766.4 |
| Tool duration | 158.7 | 149.6 |
| Tool result → receipt enqueue | 59.3 | 36.3 |
| Receipt creation → actual SQLite commit marker | 12.1 | 10.9 |
| Receipt enqueue → server event yield | 14.6 | 6.5 |
| Browser submit → native confirmed end | 6180.6 | 7664.0 |
| Native confirmed end → browser receipt arrival | 159.3 | 90.4 |
| Browser submit → receipt arrival | 6340.0 | 7754.4 |
| Browser receipt arrival → ChatKit response.end | 22.0 | 13.3 |

Python model/request/tool/receipt rows above belong to the respond-local monotonic context. Browser/native spans use matching document clock IDs, not Node/Python wall timestamps. Native mutation/readback itself was 11.6/11.1 ms. Actual HTTP provider request ID was explicitly unavailable; response hashes cannot diagnose provider-side queues. No text-first event or second model request occurred; these were factual receipt completions, with no requested final narration to time.

The dominant observed wait is before/while the provider produces complete arguments. Starting mutations during argument streaming could recover only the observed 184–311 ms before normal dispatch, and would compromise whole-response/compound semantics. This is not justified by the measured benefit. Preserve installed SDK dispatch and authorization/persistence ordering.

Receipt arrival/end gaps do not show a seconds-long browser delivery tail. Rendered Door opened was observed separately by the orchestrator, but no first-render timestamp exists; 22/13 ms until response.end is not a rendering measurement. Direct door had receipt arrival253.8 ms and no model call, further separating mechanics from provider latency.

Python diagnostics themselves cost83.9 ms across28 writes for the first trace (about3.0 ms/write, max6.0 ms). Smallest potential Python optimization is bounded buffering of metadata diagnostics with explicit flush/drop/error accounting rather than synchronous file lifecycle at every marker. It must preserve immediate SQLite receipt durability and stream ordering; it is a sub100 ms opportunity in this one sample, not a fix for the3.8–5.8 s model segment. Another small candidate is avoiding an identical redundant receipt write by ChatKit after yielding an already persisted receipt, only after exact scoped-content equality proves the SDK update is unchanged. Neither candidate was implemented here.

Telemetry caveat: Python initial/final ChatKit store rows use the original request context's origin; respond copies context and resets its origin. Repeated store-item-commit-complete for the receipt after event yield therefore cannot be subtracted blindly from respond-local rows even though component/traceId match. Future measurement-only repair should label origin identity or carry one immutable origin; current table excludes the outer SDK rewrite row. Tool exchange and receipt commits inside the hook are comparable.

Larger safe candidates lie in the separately investigated credentials/context intervals; context worker owns them. Compare equivalent controlled samples before changing those paths. Faster-model/provider experiments remain separately approved optional work. No new queue behavior, speculative tool execution, or server intervention is warranted by these observations alone.

Follow-up authorized measurement repair (offline): app.py now includes scopeId on every Python row and resets scope together with origin. Added a test proving outer pre/post-store rows share a scope and copied response rows differ. Existing live benchmark rows lack this field and retain the caveat above; no benchmark was repeated.
