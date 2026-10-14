# Independent bounded stream-finalization repair

2026-10-04 UTC. Authorized offline inspection/tests only; root owns app.py and its primary tests. This reviewer owns test_stream_finalization_independent.py and this report. No inference, native/canon mutation, restart, allowance update or model/provider/turn-cap change.

Installed SDK reproduction confirms the Stage A mechanism: exact approved multi-sentence door prompt has no trusted completionContract. One fake streamed model response invokes the door tool; complete paired exchange, confirmed receipt and ledger consumed1 persist. With max_turns=1, the real SDK raises MaxTurnsExceeded after that tool result rather than issuing a second model request. This is direct offline reproduction; the historical live browser preserved only generic stream.error, not the exact exception class.

Repair review: narrowly catch MaxTurnsExceeded around respond's stream iteration and emit an explicit ErrorEvent allow_retry=false, stating full request completion is unconfirmed and preserved receipts must be reviewed without replay. Never relabel a confirmed step as full compound-intent completion. Existing matching trusted completionContract finalizer remains clean after one request. Scoped generic exceptions also become sanitized nonretry states only for an acceptance-budget run or attempted tool; ordinary failures before tools still propagate. Exception text is not exposed; trace stores type only. CancelledError remains uncaught BaseException with existing finally cancellation; root owns its separate cancellation tests.

Independent current tests6/6 pass with installed Agents SDK and fake Model, mocked read_foundry and in-memory sole existing store:

- Exact Stage A text/no contract/one-call cap reproduces MaxTurnsExceeded after one confirmed call and retains paired protocol and receipt.
- Repaired respond retains confirmed receipt, durable ledger consumed1 and explicit nonretry partial terminal state with no second request.
- Uncertain native outcome retains diagnostic receipt, explicitly says completion unconfirmed and never claims Door opened.
- Matching trusted contract completes cleanly in one request, preserving native protocol/receipt.
- Acceptance-run generic failure is nonretry, and exception secret marker is absent from event text and typed traces.
- Ordinary pre-tool unrelated failure remains its original exception rather than being mislabeled budget completion.

One initial independent assertion incorrectly expected uncertain receipts absent. Existing design correctly preserves their factual failure diagnostic; the test was corrected to distinguish non-confirmed receipt text from success. No production change was needed for that assertion.

Private test log: C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/stream-finalization-independent.log. Tests use no network/provider/native requests. Counts are six independent cases, overlapping root's primary coverage; do not add them as unique aggregate totals.

A truly clean final result for the exact current text cannot safely be inferred merely from its receipt: current server parser accepts exact sole commands, and Python must not duplicate/broaden that parser or assume unknown follow-on clauses are completed. Possible future options are a separately reviewed receipt-only semantic contract at the existing trusted server owner, or fresh approval for the parser-supported sole sentence. Neither is implemented or used here. Do not silently alter the approved prompt, loosen parser matching, default-finalize every confirmed tool, enlarge one-call caps or reuse unused allowance.

This offline repair does not retroactively make the failed live trial successful. No second live trial/retry is authorized by this validation. Loaded repair verification requires a separately authorized deployment/restart; follow-up inference still requires explicit bounded approval and manual restoration/feedback gates.

Final expanded independent validation: 8/8 passed in 5.879 seconds (`python -m unittest test_stream_finalization_independent -v`). Added file-backed temporary SQLite close/reopen recovery: exact serialized items and IDs survive, including the complete matching tool-call/result pair and confirmed Door opened receipt; consumed allowance remains 1, and a further consumption attempt is rejected without changing it. Recovery performs storage reads only, with no respond, model attempt or mutation replay.

Added ordinary attempted-tool/provider-failure coverage with no acceptance budget: the first fake SDK response produces a confirmed tool receipt; the second fake provider attempt raises. The response preserves the paired exchange and receipt, emits an explicit nonretry partial-result error, keeps private exception details out of that error, and creates no acceptance-ledger rows. Two fake attempts here exercise normal compound flow; they are not external inference and do not change normal or acceptance request limits.

Final test evidence: `.runtime/foundry-ai-dungeon-master/stream-finalization-independent.log`. Production ownership remains with the parent; this worker edited only the independent test and this report. Runtime was not restarted and the on-disk repair is not established as loaded. External model requests, native mutations and deployment actions: zero.

Receipt-only integration independent follow-up: source TypeScript tests 2/2 pass; expanded Python suite 9/9 passes (15.075s). Exact Stage A text derives the exact scene/door/open contract for both supported message types. Full anchoring rejects extra retrieval, narration or mutations, changed restrictive clauses, quoted instructions, nonempty attachments/quoted_text, multiple content parts and unresolved scene/door descriptions. The new eligibility branch alone rejects these extra inputs; existing unrelated parser branches are outside this change.

Python finalization accepts only the confirmed matching fixture receipt and rejects wrong world, schema, scene, door, action value, actual state, pending outcome, multiple tool results/calls/requests, mismatching executed arguments and nondurable exchange. Existing real installed SDK tests retain clean one-call finalization when the trusted contract matches; uncontracted compound requests preserve nonretry partial status. Durable close/reopen and ordinary post-tool provider-failure tests remain passing. Parent owns cancellation and cross-language authenticated HTTP tests, whose results are reported separately rather than claimed by this independent run.

Reviewed the existing gateway forwarding and Python finalizer: authenticated gateway contract remains completion eligibility only; Python exact schema/tool arguments, world, native result and persisted single exchange checks remain authoritative for eligibility. No gateway/preparation or production Python edits by this worker. No dist build, runtime deployment, inference, action replay or native mutation occurred. A successful source fixture is not live acceptance; compiled deployment and a fresh separately approved bounded live test remain gates.

New independent TS evidence: server/src/chatkit/receipt-only-independent.test.ts. Python evidence: chatkit-server/test_stream_finalization_independent.py and private receipt-only-python-independent.log. Initial added Python eligibility fixture omitted required model/apiKey/readRun setup; test-only fixture was repaired, then final nine-case run passed.
