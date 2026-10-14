# Routine command rollout acceptance

The user approved expansion after the pause experiment and approved six embedded-chat requests on dedicated reversible fixtures. All six passed independent live validation. No further inference was run. Existing unrelated repository changes were preserved; nothing was pushed.

## Changes

AI DM: first-turn typed pause, token movement (including bounded batches of eight), door state, absolute HP, conditions, initiative, combat advancement, dnd5e ability/save/skill rolls, bounded state reads and existing campaign reads. The existing Python ChatKit loop and TypeScript services remain the execution path. `/ai-control` shortcuts use the same authenticated service and world ordering. Safe Foundry 14 paragraph envelopes are normalized before shortcut parsing. Small overview caching validates content and permission revisions; uncommon tools remain discoverable.

MCP module: `foundry_core_action_confirmed` and `foundry_core_state`, alongside the confirmed pause setter. Current GM/world authorization, typed validation, target resolution, serialized mutations, deduplicated receipts, origin markers and authoritative acknowledgement/readback stay inside the backend. Ambiguous outcomes fence further mutation instead of blindly retrying. Combat advancement uses Foundry's supported `nextTurn()` semantics. Movement batches report partial results and are not atomic.

HP supports dnd5e; actor rolls support reviewed dnd5e ability/save/skill APIs. Item/attack/rest, specialized systems, administration and destructive operations remain outside this compact toolset. Availability never substitutes for execution authorization.

## Live results

Configured model: `gpt-5.6-sol`, reasoning `none`. Six user messages consumed twelve model requests and six typed calls, with no discovery/schema loading calls. Each action needed one tool call and a second model request for its brief acknowledgement.

| Command | Arrival to confirmed action | Arrival to final stream completion |
| --- | ---: | ---: |
| Unpause | 4.515 s | 6.605 s |
| Open door | 3.709 s | 5.937 s |
| Move token | 4.336 s | 6.512 s |
| Stealth skill roll | 6.746 s | 9.054 s |
| Set HP | 5.949 s | 8.042 s |
| Next combat turn | 5.526 s | 9.250 s |

Unpause was the first call after restart; later calls used a warm process, with different context preparation paths. One sample per family cannot establish median/tail latency or a reliable before/after improvement for those families. Browser paint was not timed. Historical pause user-to-assistant spans of 8.172–16.044 s are a different measurement and should not be treated as a direct action-latency baseline.

The direct door shortcut returned confirmed state with the model request count unchanged at twelve. MCP acknowledgements for the first three commands took approximately 57–191 ms. Context preparation for detailed roll/HP/combat wording took 1.5–3 s; model time remains material. These are useful targets for later speed work. No numerical latency target has been agreed.

## Validation and limitations

Independent source/unit gates: PASS. Both module builds and applicable typechecks passed. AI tests included bootstrap 7, shared 9, server 239, module 40 and Python 26; the final shortcut repair additionally passed its focused parser/hooks checks. MCP server 521 and module 278 tests passed; the supported combat API repair passed fourteen focused checks and builds. An initial unrelated movement-worker test failure passed isolated and on full rerun.

Independent live gate: PASS for all six commands, canonical state and persisted confirmed receipts. Fixtures were restored and left inactive; the original campaign scene, pause state and active combat state were restored. Reconnect and replay behavior has offline coverage and final runtime reconnection was checked. Name ambiguity, live multi-target partial failure, unsupported-system behavior and the full disconnect/failure matrix were not exercised through paid inference. Remote client paint/readiness is not claimed.

## Build and reload

Run `npm run build` from each module root:

* `C:/dev/FoundryVtt/Data/Data/modules/foundry-local-api`
* `C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master`

Both builds have already been run. Restart Foundry using the existing launcher, then reload/rejoin the GM browser so the MCP client, Node service, Python service and browser bundles all refresh. The final local runtime has already been restarted and rejoined. The temporary acceptance-only four-turn guard was removed; normal default allowance is eight.

Confirm the AI health/build report identifies policy `core-actions-v1`, Python prompt `solo-dm-v8-core-actions`, and artifact hashes matching the current built files. The MCP capability report should include `coreActionConfirmed` and `coreState` for the authenticated GM in the intended world. Final independent identity evidence accompanies the report.

## Evidence and manual use

Evidence is in `docs/core-rollout-evidence`: `live-traces.json` separates arrival/queue/context/model/tool/acknowledgement/final events; `live-receipts.json` and independent receipt/state files record authoritative outcomes. Runtime logs are under `.runtime/core-acceptance-stdout.log` and `.runtime/core-acceptance-stderr.log`; the normal restored launch uses `core-runtime-stdout.log` and `core-runtime-stderr.log`. These local logs may include normal application data and should be reviewed before sharing.

In embedded chat, ask to pause, unpause, repeat unpause, then reconnect and repeat. Use a dedicated scene for movement, doors, HP and combat tests. The native action review displays confirmed results; uncertainty is an explicit outcome, not success. The approach merits retaining and expanding only where reviewed system support exists. Further optimization should target the measured context/model delays while preserving ordering and authority checks.
