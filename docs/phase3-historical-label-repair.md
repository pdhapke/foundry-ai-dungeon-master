# Phase 3 visible historical narration basis repair

The approved live trials confirmed durable receipts and boundary acknowledgements, but prompt instructions alone did not reliably identify narration as historical: HP prose said “now” without a visible scope notice. Both later controls occurred after narration finished, so those trials did not prove overlap. The four approved model requests are exhausted; this repair is offline and unloaded.

## Change

`chatkit-server/app.py` now persists a deterministic standard ChatKit assistant message before the narration model continuation: “Narration describes the completed action: [confirmed factual receipt] Later actions may have changed the world.” This uses the validated receipt already required by the existing boundary. It adds no model request, changes no provider, and preserves the durable function-call/result pair, immediate receipt, permanent mutation fence, and authoritative server release ordering.

The stable message ID follows the boundary scope. Persistence completes before its `ThreadItemDoneEvent` is enqueued and before the next model request. A cancelled delivery leaves the message available in reloaded history. Repeating the helper does not insert or emit a duplicate; conflicting content under the same identity fails. The label is also present if release acknowledgement is unavailable, because the mechanics receipt remains confirmed while server-release uncertainty remains fenced. No UI render or loaded-runtime success is claimed from SDK event tests.

## Validation

- Installed Agents/ChatKit fake-model narration suite: 9 PASS (14.853 seconds).
- New historical-label suite: 2 PASS (2.242 seconds). Proves receipt-before-label delivery, label persistence before model request two, unchanged two-request count, complete protocol history, cancelled delivery, SQLite reopen, duplicate suppression, and identity conflict rejection.
- Full Python suite: 80 PASS (98.047 seconds), captured in `phase3-historical-label-all-tests.txt`; no baseline failure or regression observed.
- Independent validator: offline PASS received by the orchestrator. Browser rendering and actual narration/control overlap remain separate live gates.

Evidence files: `phase3-python-tests.txt`, `phase3-historical-label-tests.txt`, `phase3-historical-label-all-tests.txt`. Tests use fake models and temporary stores; no inference or server lifecycle action occurred.

## Manual acceptance

The running Python build does not include this repair. The user must manually update/restart the managed stack as directed by the orchestrator and verify the prepared identity before new acceptance. A targeted client refresh may be required by the orchestrator. Browser rendering of the label and a control actually overlapping narration remain live acceptance gates and require a new explicit inference budget. Fixtures from the exhausted trials were restored independently.


