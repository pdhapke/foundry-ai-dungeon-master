# Phase 3 Python narration boundary evidence — 2026-10-02

Gate: focused installed-SDK tests PASS; final full suite PASS; independent Python validation PASS, authoritative Node/MCP validation pending. Live acceptance remains unverified; no services, provider calls, frontend/TypeScript/MCP code, automatic settings, or live world fixtures were changed by this worker.

Read root REPOSITORY.md and inventoried chatkit-server before editing: app.py/dm_prompt.py/test_app.py already modified, performance/combat/latency tests already untracked. Existing unrelated work was preserved.

## Eligibility and authoritative boundary
The authenticated gateway supplies x-chatkit-narration-contract (base64 JSON, same typed version1 routine toolName/arguments contract). The TS parser owns exact sole-mechanics request semantics plus the explicit 'and/then narrate the result' suffix. Python never infers whole-request completion from narration keywords or one successful tool alone.

At the installed SDK callable tool_use_behavior boundary, Python requires the first model request, exactly one executed tool/result, matching tool schema/arguments, confirmed matching world/action/requested observed state and prior complete exchange plus factual receipt persistence/delivery. Compound requests, missing contracts, retrieval-first work, wrong actions, failure/uncertainty and additional calls retain ordinary capabilities/queue ownership. Supported scope is the existing nine routine action types with explicit IDs; attacks, batches and broader compounds are not declared complete by this gate.

Before requesting release, Python persists a pending narration boundary marker. It then permanently removes tools from that run and fences every ordinary read_foundry adapter operation. The sole allowed operation is release_mutation_capability {version:1}. Node must validate the authoritative recorded receipt, absence of active adapter work/current authorization, persist permanent readRun revocation and only then release its world mutation slot. Python alone cannot establish this ordering; the TS/MCP worker and independent validator own that gate.

A validated Node acknowledgement requires version1, mutationCapability=permanently-revoked, exact scope 'confirmed-receipt-observation; may be superseded', 64-hex receiptDigest and observation stateRevision. Python persists these as the historical narration basis and continues the same Agents/ChatKit loop with no tools. The narration prompt uses the completed action as past evidence rather than asserting that later state is necessarily unchanged. No extra classifier/model loop was added.

Lost/malformed acknowledgement never restores the old tool set or adapter capability. A cancelled transport can leave a pending marker plus durable receipt; remote server revocation remains authoritative. Definite acknowledgement loss retains the ordinary slot until gateway cleanup unless Node has already irrevocably released it; no Python assumption releases the slot. Reconnect/history replay retains complete tool protocol and the receipt; a next human turn uses a new run, never the old fenced capability.

## Validation
chatkit-server/test_phase3_narration.py drives the installed Runner.run_streamed and ChatKit stream_agent_response with fake models and authenticated-adapter fixtures, without network or live inference. Covered:

- Complete exchange/factual receipt/pending marker exist before boundary request; tools are empty before the request awaits.
- Narration continues as the second model request with no tools and persisted receipt/revision basis.
- Missing/compound contract, retrieval-first, wrong action, failure and uncertainty do not request release.
- A model's delayed mutation after the boundary raises SDK ModelBehaviorError without a second adapter mutation.
- Direct local adapter attempts including discovery/tool_execute, attacks, damage, batches and context reads are denied after the fence.
- Cancellation losing remote acknowledgement preserves pending marker, receipt/protocol and local fence without a second model request.
- Cancelling the narration itself preserves confirmed marker/receipt and never redispatches mechanics.
- Malformed acknowledgement never restores tools; SQLite reopen reconstructs the receipt/boundary; repeated callback is inert.
- The next SDK turn accepts stored call/result history without inheriting the old run's fence as authority.
- Contract version rejects booleans rather than accepting true as integer1.

Detailed outputs: phase3-python-tests.txt and phase3-python-all-tests.txt. Existing completion, cancellation, replay, auth and latency tests remain in the full suite. Cancellation may be represented by the SDK as a closed stream rather than a raised exception; tests assert durable state and actual request/operation counts.

## Remaining acceptance
Independent tests must prove the Node fence across every native/discovered mutation route, shared ordering across core/attacks/damage/batches, revocation-before-release, restart recovery, world/user isolation and concurrent controls. Source tests do not establish live concurrency or latency improvement. All current source changes require the user's manual loaded-build update, then approved fixtures/inference budget for narrated-command acceptance with a control during narration. Current model cap and authentication readiness must be checked independently; no server action was taken here.

Final validation capture: focused narration suite 9 tests PASS in 5.634 seconds; final full Python discovery 78 tests PASS in 86.442 seconds, no baseline failures observed. Independent validator separately ran 2 additional wrong-state/local-fence tests PASS and reran the nine narration tests PASS.
