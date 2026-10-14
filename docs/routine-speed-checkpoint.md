# Manual routine-command speed checkpoint

STOP: phases 4–6 remain pending your manual speed feedback. No new paid inference or dedicated live mutation ran in this speed stage. Do not interpret successful offline checks as live acceptance.

## Reload the working build

Builds are prepared in both installed module folders. Save any ongoing play, use Foundry's Main Menu → Return to Setup, then shut down Foundry normally. Start it with your existing launcher and reopen the same world. Reload/rejoin the GM browser, then reopen the embedded AI Dungeon Master panel. Restarting only the browser does not reload the in-process TypeScript and Python services.

Check loopback health at `http://127.0.0.1:3939/health` and `http://127.0.0.1:3940/health`. The AI health build `startedAt` must be after your restart. Compare its startup `artifactHashes` to `docs/routine-speed-evidence/checkpoint-build.json`; check `http://127.0.0.1:3941/health` and match its `codeDigest` to `pythonCodeDigest` in that manifest. Startup hashes describe the loaded process, not later disk edits. The browser bundle must be freshly loaded. Keep the configured model and reasoning unchanged.

## Six commands in a dedicated fixture

Use the existing inactive core-rollout test scene, actor, token, door and combat recorded in `docs/core-rollout-evidence/live-fixture.json`, or a disposable equivalent. Record original active scene, pause and combat before activating the fixture. Never use campaign actors for HP/combat experiments. Existing fixture initial values are token (200,200), door closed, HP20/20 and combat round1/turn0 inactive.

In the embedded chat, test these one at a time (substitute the fixture's explicit IDs):

1. “Unpause the game.” Confirm the world state and brief result.
2. “Open door <doorId> in scene <sceneId>.”
3. “Move token <tokenId> in scene <sceneId> to x400 y300.”
4. “Set actor <actorId> HP to 18 in scene <sceneId>.”
5. “Roll the Stealth skill (ste) for actor <actorId> in scene <sceneId> using dnd5e.”
6. “Advance combat <combatId> in scene <sceneId> one turn.” Start only the dedicated combat first.

Compare short and detailed wording for HP/roll/combat. Also test a compound request such as opening the fixture door and then describing the situation; it must continue after the confirmed result. Reopen the panel and ask about the previous result to check persisted continuity.

Direct controls in ordinary Foundry chat use `/ai-control door <sceneId> <doorId> open`, `/ai-control move <sceneId> <tokenId> 400 300`, `/ai-control hp <sceneId> <actorId> 18`, `/ai-control actor-roll <sceneId> <actorId> skill ste`, and `/ai-control next <sceneId> <combatId>`. These use the same execution service without inference. Pause uses the existing native pause control.

Record separately: submit→confirmed action, submit→visible receipt, and submit→final narration. Existing instrumentation does not prove browser paint. Report individual observations unless repeated samples support distributions. Proposed aspirations remain subsecond local direct control/perception and roughly2–3seconds natural-language actions; agree numerical acceptance targets from your feedback.

Restore token position, door, HP, dedicated combat, original active scene/pause/combat, and leave the fixture inactive. Report any restoration failure. No fixture was changed by this speed stage.


Final checks: both module builds/typechecks/full suites PASS; Python31 tests PASS. Independent offline gates PASS; new live acceptance BLOCKED pending this checkpoint. Only sole pause eliminates its second model request. Other receipts render promptly with continuation. Context reads are fresh each turn; cross-turn revision caching is deferred. First-model latency, precise backend validation/readback timing, real browser rendering, and generative duplicate prose remain unmeasured for this build. See routine-speed-validation.md for boundaries.
