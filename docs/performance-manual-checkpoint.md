# Pending manual speed checkpoint

Implementation, full module checks, and independent Phase1/2 offline gates PASS. AI314 and MCP894 tests pass; both typechecks/builds pass; Python worker38 and independent SDK14 tests pass. Prepared30/30 disk artifacts match the manifest; loaded runtime matches only25/30 and requires manual restart. Live acceptance remains BLOCKED. Phases 3–5 remain disabled pending explicit user feedback and approval.

## Current prerequisites

Current read-only observation: Foundry 14.368 responds at localhost:30000/auth and reports no active game; MCP world status is NOT_CONNECTED. The user must open the intended world manually and join the test GM. In the embedded AI DM panel use **Refresh status** (no inference). If eligible models are unavailable, use **Continue with ChatGPT**, permit its popup, then select an eligible model returned by that provider. Do not enable API fallback. Historical expired authorization is not a current validity finding.

Changes to in-process TS/Python require a manual normal Foundry shutdown and relaunch. Save ongoing play, use Main Menu → Return to Setup if a world is active, shut down Foundry normally, start it with your existing launcher, reopen the intended world and rejoin as the test GM. This agent never performs those actions. After confirmation, compare 3940 health manifestDigest and all artifactHashes with performance-checkpoint-build.json; compare 3941 health codeDigest with its pythonCodeDigest. The manifest's preparedAt describes offline preparation, not a running process. Policy remains core-actions-v1. Verify the intended browser bundle after reconnect. Targeted remote reload is allowed only for the intended opted-in test client and never substitutes for server restart.

Discovered remote reload schema: foundry_reload_client({clientId?, userId?, correlationId, delayMs?, minimumModuleVersion?}). Require the exact verified intended test client and unique correlation ID; its acknowledgement proves scheduling only. Then verify reconnection with foundry_get_client_readiness and loaded frontend hash. Do not broadcast or reload unrelated clients.

## Reversible fixture and measurement plan

Use the inactive fixture in core-rollout-evidence/live-fixture.json only after read-only confirmation that its IDs still exist and are disposable: scene 2RJeJKqdpEE4VZPh, actor QvhdPrU8dHE1nm4h, token gHxvFbZTMoim2tYp, door RsB12oN5v3LYI1XR, combat F72hDz6efnhuYqKb. Saved IDs and values are historical, not current state. Capture current original scene, pause, combat, fixture token/door/HP/conditions and combat state before changing anything. Restore captured values and leave fixture inactive afterward.

Embedded sole commands:

1. Unpause the game.
2. Open door RsB12oN5v3LYI1XR in scene 2RJeJKqdpEE4VZPh.
3. Move token gHxvFbZTMoim2tYp in scene 2RJeJKqdpEE4VZPh to 400,300.
4. Set actor QvhdPrU8dHE1nm4h HP to 18 in scene 2RJeJKqdpEE4VZPh.
5. Roll actor QvhdPrU8dHE1nm4h skill ste in scene 2RJeJKqdpEE4VZPh.
6. Advance combat F72hDz6efnhuYqKb in scene 2RJeJKqdpEE4VZPh turn. (Start only this dedicated combat first; omit this parenthetical from the request.)

The exact command forms above qualify for sole completion. Label-based commands and other phrasings requiring retrieval still continue; this is a documented partial coverage limit. Compare equivalent short/detailed requests and one compound request with requested narration; reopen the panel and verify persisted continuity. Record separate timestamps for queue wait, preparation, model-to-tool, execution/readback, receipt persistence/delivery, actual visible action/receipt, and final narration. A factual receipt may be the completed final output for a sole command. Record sample counts and cold/warm conditions; do not infer a latency distribution from one sample each or call mocked timing live latency.

Agent-driven model tests require explicit approval specifying a bounded request count and spending/usage cap for the configured model. Optional faster-model comparison is a separate approval. No live fixture mutation or inference has occurred in this run.
