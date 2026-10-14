# Phase 3 AI Node mutation boundary

2026-10-02. User explicitly reopened Phase 3 after the manual speed checkpoint. Root REPOSITORY.md was read; the dirty/untracked inventory was captured before editing in phase3-start-ai-inventory.txt. Existing work was preserved. No model request, runtime fixture change, service lifecycle action, push or publish was performed.

Owned source: AI shared/chatkit.ts; server/chatkit/narration-request.ts, narration-boundary.test.ts, read-tools.ts, turns.ts, gateway.ts; server/index.ts and build-identity.ts. Python is separately owned; MCP ordering changes are root-owned.

## Contract and authoritative ordering

Eligible handoff requires one completely specified direct human mechanical command with an exact `and narrate the result` or `then narrate the result` suffix. The existing typed routine parser supplies tool name and every exact argument. The gateway sends x-chatkit-narration-contract only when the boundary feature gate is enabled. Compound, target-label/retrieval-first, ambiguous or uncertain requests retain the whole world slot; no unfinished batch is truncated.

Python validates the actual tool call, durable tool-call/result exchange and factual receipt before requesting authenticated adapter operation release_mutation_capability with `{version:1}`. Node trusts neither a submitted receipt nor a sidecar assertion of completion. Its bound run records the authoritative confirmed native service result and requires exactly one eligible mutation attempt, no unrelated tool use and zero active adapter calls.

Node independently validates complete requested readback for all nine supported tools: HP/door/movement/condition/initiative exact values; native dice formula and finite total; native system/key/type and nonempty finite roll evidence; combat advancement confirmed mutation plus valid round/turn/count; pause exact boolean. A successful action echo with missing/wrong state cannot release the slot. The initial independent review caught weaker state-object-only validation; this was repaired before enabling.

The run permanently enters sealing before asynchronous current-GM authorization. Every other adapter operation—generic discovery/execute, native actions, attacks, damage, batches, world files, campaign proposals and reads—then fails before provider dispatch. Failure, cancellation, acknowledgement loss or later revocation never restores mutation capability. All adapter tools remain denied during narration; Python also removes tools before waiting for acknowledgement.

After live authorization and complete-receipt validation, the run becomes revoked. Its queue lease transaction durably inserts the narration-boundary receipt/state digest and changes the event status to narrating before resolving the world tail. New controls may enter while the older HTTP response continues. Response completion settles the event without unlocking twice. Callback failure leaves the adapter permanently revoked; retry can repeat only the acknowledgement path with current authorization. Recorded event replay always remains denied, including after restart. In-memory old capabilities disappear on process restart.

Returned acknowledgement: version 1; mutationCapability permanently-revoked; SHA256 receiptDigest and stateRevision; stateRevisionKind receipt-state-digest; scope `confirmed-receipt-observation; may be superseded`. This is an observation digest, not a fabricated global Foundry revision. Narration must be explicitly tied to that historical receipt and cannot present it as necessarily current after new controls run.

## Shared ordering prerequisite

After local and independent gates passed, root explicitly authorized the user-requested source enablement: index.ts mutationBoundaryEnabled is true and supplies both gateway and adapter gates. The running stack remains unchanged until manual restart. Root MCP work unifies reviewed native core/session/attack/damage/confirmed-pause ingress without nested acquisition; reviewed server calls use the shared mutation lane. AI direct controls and batches retain their full AI world slot. Existing movement batches remain sequential/non-atomic; independent external callers can interleave at per-step boundaries. Unreviewed generic native endpoints and direct Foundry UI mutations cannot be claimed globally ordered by this contract. No capability to issue those paths survives a released AI run.

## Validation and deployment boundary

Focused AI Node suite after semantic repair: 20 PASS, zero failures, covering nine-tool state evidence, conservative grammar, durable release, concurrent queued controls, delayed calls while authorization is pending, current revocation, inflight dispatch rejection, uncertainty, gate OFF, cancellation, world isolation, acknowledgement loss, repeat acknowledgement and replay/restart. Final full AI server suite: 272 PASS; all AI workspace typechecks and full build PASS. Evidence: phase3-ts-tests.log, phase3-ai-server-full-tests.log, phase3-ai-typecheck.log and phase3-ai-build.log. phase3-ts-prepared-build.json explicitly captures prepared on-disk artifacts and compiled enabled gate; it does not claim the running process loaded them.

Independent validator reported the narrow boundary PASS after the requested-state repair. Python SDK and MCP/native ordering gates are reported separately by their owners. Actual slow narration/concurrent-control live acceptance requires the user's manual stack restart, loaded artifact verification and separately bounded inference approval. Source completion and controlled fake-model tests are not live acceptance. New narration-request.js is included in startup artifact identity.
