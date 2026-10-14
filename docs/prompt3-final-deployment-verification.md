# Combined Prompt2/3 deployment verification

2026-10-04 UTC. Deployment-only takeover; no source repair was necessary. Read Prompt2 resume and Prompt3 combined handoffs. Existing tested compiled disk was deployed; aggregate suites were not rerun because deployment changed no implementation.

## Visible stack ownership and restart

Fresh Win32 verification established window6424490 is visible and owned by minttyPID23132, matching the actual persistent MSYS shell. Current old listeners were Foundry47912/MCP2276/AI13536/Python45948, not guessed from historical references. Profile inspection confirmed `.bash_profile` sources `.bashrc`; current alias remains `node "C:/dev/foundryvtt/App/main.js" --dataPath="C:/dev/foundryvtt/Data"`. Actual pre-stop terminal screenshot showed stack logs. Today's explicit graceful-stop/relaunch permission was used.

Ctrl+C delivered only to the freshly verified visible terminal. Screenshot `terminal-stopped.png` shows SIGINT, successful shutdown and the interactive C:/dev/FoundryVtt shell prompt. Independent process/listener/lock check at04:25:10UTC: all4listeners absent, relevant stack processes absent, both rootlock and Data/Config/options.json.lock absent. No kill/delete/hidden launch/separate component launch. The same alias was entered in the same visible persistent shell; terminal and old logs remain available.

## Current loaded gate

| Service | Fresh startup | Verified load |
|---|---|---|
| AI |04:25:44.277UTC|74/74required hashes match current disk; zero null/missing entries; Ready; requests0|
| MCP |04:25:43.809UTC|17/17required hashes match current disk; zero null/missing entries; OK|
| Python |Fresh restarted child|Loaded app/context digests match disk; promptv9; Ready; normal maxModelTurns15|

The existing `scripts/prompt3-combined-runtime-check.mjs` was run model-free. Its prior runtime report was copied to `runtime-identity-before-final-restart.json` before new evidence was written. Independent reviewer repeated all artifact checks and data/privacy verification; see prompt3-final-deployment-independent.md.

All170protected campaign files,86public media files and0prepared-map files retain identical byte/SHA inventories. Canonical ChatKit170rows/11tables and operations469rows/38tables retain all logical rows/fingerprints; integrity checks pass using read-only SQLite online backup into memory, not hot file copying. Encrypted provider state hash unchanged. Seven independent anonymous Range/encoded former private campaign/transcript/operational URLs returned404; response bodies were not read or printed. This is scoped static-route proof, not broad media disclosure or narration secrecy acceptance.

## Actual browser and visual limits

Existing designated Chrome window1183168 was reidentified through its actual localhost route. After restart it was at/no. Only this designated verification tab was navigated to/setup; it redirects to/auth and displays Administrator Access Required/no active game. No password entered/guessed, no authentication bypass, no unrelated tab/session changed. Fresh screenshot `final-browser-setup.png` was captured only after its foreground handle was verified; actual screen shows the authentication gate.

There is no authenticated GM game available for actual `/prepare`, campaign retrieval, native handlers or `api.build.compactPanel === 'prompt3-v1'` verification. DM layout at normal/compact viewport, keyboard/Stop/review reachability, scrolling/clipping/composer overlap and signed-out/expired/domain/model states were NOT tested live. No baseline/after DM viewport gain is claimed. A separate final terminal screenshot was not captured: window-root UI focus is unsupported and foreground verification failed, so no screenshot was fabricated. Initial visible terminal/clean shutdown screenshots, fresh IsWindowVisible/owner checks, foreground alias input and independent startup identity are retained.

Smallest required user action: Peter unlocks Foundry setup in the designated browser, launches izzy-campaign and joins Gamemaster. Then parent/deployment owner can complete zero-inference authenticated readiness, browser build marker and visual checks; stop for Peter's feedback. No fresh terminal restart is needed merely for this join.

## Remaining gates and boundaries

Private canonical overview.md/index.md are still absent. Prompt2 source-backed review packets remain private/unpublished; exact human factual/disclosure review and publication are separate. Prompt3 generic action drawer does not grant preparation publication/native application authority. No canon published, source altered, asset imported, native scene applied/activated, live gameplay mutation, model switch, billing change, inference/embedding/image/summary request, allowance activation or push. Automatic settings unchanged. Prior narrow deterministic corridor acceptance does not establish broader player/narration/TV acceptance.

Private evidence root: C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/prompt3-combined-evidence/. Includes final-shutdown.json, runtime-identity.json, preserved prior runtime report, terminal-before.png, terminal-stopped.png, final-browser-gate.json and final-browser-setup.png. Independent before/after retention evidence resides in its sibling prompt3-final-deployment-independent/.
