# Pause/unpause manual checkpoint

October 1, 2026. Scope ends here until the user tests and explicitly approves continuation. No new live model calls, restart, deployment, push or game mutations were performed for this experiment.

## Changes

AI DM: Python's existing ChatKit Agent now exposes `foundry_set_pause_state(paused: bool)` on the first authenticated turn. Recognized simple pause/resume requests use only that tool plus permanent DM instructions and a bounded campaign overview, skipping campaign retrieval and actor reconstruction. Other natural-language wording still has the typed setter available but may retain full context. Node binds identity/world/request IDs, validates current authority, durably deduplicates, performs one confirmed MCP operation and records compact receipts. Supported GPT-5.1+ configured model names use reasoning `none`; other model names retain supported defaults. No provider or tier changes. Existing world inference ordering is retained. JSON timing instrumentation spans gateway, Python, backend and GM browser.

MCP (`C:/dev/FoundryVtt/Data/Data/modules/foundry-local-api`): additive `foundry_set_game_paused_confirmed` capability uses explicit desired state, exact authenticated opted-in GM routing, live GM/world checks, serialized pause requests, bounded duplicate receipts, sticky uncertainty and canonical GM read-back. Supported Foundry `game.togglePause(desired, {broadcast: true})` applies state. Origin/correlation scope surrounds synchronous Foundry hooks. Historical duplicate replay rechecks live world/authority and refuses changed bridge connection generation. Legacy tools remain available.

## Build and reload

The workers built both modules successfully. To reproduce in PowerShell:

```powershell
Set-Location C:/dev/FoundryVtt/Data/Data/modules/foundry-local-api
npm run build
Set-Location C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master
npm run build
```

Stop Foundry through your normal workflow, then start it through its existing `C:/dev/FoundryVtt/App/main.js` launcher. The installation's existing child hook starts MCP first, then AI Node/Python; no new server launcher or credential setup is needed. Reload the GM browser so both module bundles and the GM bridge reconnect. Keep normal GM remote-control consent enabled.

Confirm the loaded services:

```powershell
Invoke-RestMethod http://127.0.0.1:3939/health
Invoke-RestMethod http://127.0.0.1:3940/health
Invoke-RestMethod http://127.0.0.1:3941/health
Get-FileHash C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master/chatkit-server/app.py -Algorithm SHA256
Get-FileHash C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master/chatkit-server/dm_prompt.py -Algorithm SHA256
Get-FileHash C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master/module/dist/index.js -Algorithm SHA256
```

Python health must report `promptVersion: solo-dm-v7-pause-experiment`; `codeDigest` must match app.py's SHA256. Python promptDigest hashes the imported prompt string, not the dm_prompt.py file. Node health `build.policy` must be `pause-experiment-v1`, and `build.artifactHashes` must match these files plus updated gateway/pause-action output. Node captures hashes at startup; it does not relabel a running process after disk edits. MCP package version remains 0.1.0: version alone proves nothing. Its authenticated capability inventory must include `foundry_set_game_paused_confirmed`, and connected GM capabilities `gameSetPausedConfirmed`. In GM browser Network tools, reload with cache disabled and compare loaded module scripts with disk; `game.modules.get("foundry-ai-dungeon-master").api.build` must report policy and bundleIdentity `pause-experiment-v1`; the prior generic marker is not sufficient. New browser `pause-timing` events provide an additional loaded-code check.

## Manual test

1. After restart/reload, ask the **embedded DM chat**: “Please pause the game.” Record send-to-pause-banner time and send-to-finished-reply time separately. Mark this first run cold.
2. Ask “Please unpause the game.” Verify banner removal and a confirmed false receipt. Record both times; mark warm.
3. Repeat “Please unpause the game.” Verify confirmed false without another state change. An already-correct state may have no pauseGame hook; use its authoritative receipt.
4. Reconnect/reload the GM browser, reopen embedded chat, and ask pause then unpause again. Verify no wrong-world or stale connection receipt and no automatic DM feedback turn. Mark reconnect runs separately.
5. Try varied wording such as “Could you resume play?” Verify the first-turn core tool works naturally. Full-context wording can be slower and is identified by pauseControlOnly in traces.

No /pause or /unpause shortcut was added. Every acceptance request above exercises natural-language inference.

## Evidence and timing

Save the normal Foundry parent console output: Node and Python children inherit it. Filter JSON lines with `type: pause-timing`; group by traceId, join MCP execution/receipts by correlationId. GM browser console contains `browser-pause-state-observed`, `browser-action-notification-issued` (`notificationIssuedAtMs`), and MCP pause-result with canonical `stateObservedAtMs`. Record banner appearance separately when assessing actual browser paint: hook and notification-issued timestamps are observation/issuance, not a guarantee of rendered pixels. Node first stream chunk may be workflow text, not visible action confirmation.

Stages include request arrival/initial authorization, queue wait, credentials, context preparation, each model request/settings/tool list, model response/first tool start, tool results, MCP execution and acknowledgement, stream authorization, and final response. Tool names and counts show whether discovery/load were used. Use relative same-process durations; wall-clock timestamps from different processes require clock caution. Core receipts are persisted in `chatkit_pause_actions` in `C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master/.runtime/ai-dungeon-master/operations.sqlite` by default (or the configured AI_DM_RUNTIME_ROOT) and exposed with existing recent pause actions. They distinguish confirmed, uncertain and failure. Never retry an uncertain mutation blindly; inspect current game state. The MCP pause lane deliberately blocks subsequent new pause mutations after uncertainty until inspected and restarted.

Before: historical UI thought labels were 47s unpause / 38s pause, with audited adapter spans 18.372s / 16.265s. These are secondary evidence, not action latency; cold/warm and actual model settings are unknown. Current read-only running identity is in `docs/pause-experiment-evidence/running-health-before.json`. After: unmeasured live. Offline single-call tests do not establish a latency improvement or natural-language model selection. No numerical target, median, or tail claim is justified yet.

## Limits and recommendation

Queueing still waits behind another complete world turn; traces expose that cost. Only clear short pause commands use minimal context. Canonical GM confirmation covers local state plus broadcast dispatch, not every client's acknowledgement. MCP in-memory receipts are bounded and connection-generation aware; AI receipts are durable. External human/legacy controls do not share the new pause queue. No broader command rollout is approved.

This approach merits a manual trial because it removes discovery and redundant model-controlled read calls while preserving backend checks. Expansion depends on correct natural-language behavior and measured action latency from this checkpoint. If still slow or incorrect, diagnose this experiment first. Stop here and wait for explicit approval.

