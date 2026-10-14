# Independent embedded speed checkpoint

PASS mechanics and durable conversation evidence: six approved embedded prompts produced exactly six complete persisted tool-call/result pairs and six factual receipts in thread thr_8a80466f. Independent authenticated readbacks confirmed unpaused, fixture door open, token400/300, actorHP18, native dnd5e Stealth18 (1d20+0/result18+0), and combatround1turn1. Root separately observed the rendered Ready/receipt for each. No additional prompts or retries were submitted; loaded maxModelTurns1, provider max_retries0 and automaticEventsEnabledfalse bound each submission to one model request. Actual console model trace count unavailable; this is an enforced upper bound, not a measured trace count.

PASS loaded build: all30 prepared/disk/startup hashes matched; Python maxModelTurns1 and codeDigest a5be9d7c77c0e055580a071a108b70a90519c39596d8cac36f523e810d6b40cc, manifest f3a828c9f0c7c274180217d5512040363aaf3cab72ea50d3d38f38f6134dc234, startup15:42:31.108Z. Prepared build identity/perception/model provider conditions recorded separately. No player client accepted here.

| Command | Tool-pair creation after submit | Receipt creation after submit | Browser Ready/receipt observed upper bound |
|---|---:|---:|---:|
| Pause |6.746s|6.762s|9.163s|
| Door |5.585s|5.607s|13.523s|
| Movement |9.752s|9.763s|18.262s|
| HP |13.243s|13.252s|16.601s|
| Roll |6.112s|6.134s|12.748s|
| Combat |10.667s|10.679s|12.484s|

Timing gate PARTIAL: one sample per different command in one sequential session, no distributions, cold/warm characterization or comparable prior natural-language baseline. Pause receipt alone has confirmed stateObservedAtMs (+6.704s after submission). Other tool pairs lack exact execution/readback timestamps. SQLite created_at is item creation before commit/delivery, not exact persistence completion. Browser sampling times are upper bounds, not exact receipt arrival/paint. Separate queue/context/model-to-tool/native execution/serialization/cache/receipt delivery/narration durations are unavailable because current process stdout traces were not captured. No separate narration was requested; this receipt-only test does not validate narration latency. These observations do not demonstrate a2–3s goal or a live speed reduction; they demonstrate completed mechanics under the one-turn cap.

PASS restoration: independent fresh readback performance-checkpoint-live-restored-independent.json matches pre-test performance-checkpoint-live-before.json: original active sceneNbj38PEdvw1zX1J9, pausedtrue,no active combat; inactive fixture token200/200,doorclosed,HP20max20temp0,combatinactive round1turn0. AutomaticEventsEnabled remainsfalse. Config temporary limit removed on disk by root; currently running cap1 remains until user manually restarts. No service lifecycle changes were performed by validator; no test-owned background services launched. Local read-only script/test runners exited.

STOP: manual speed feedback and explicit Phase3 continuation remain required. Broader combat/multiattack/resources/player perception and optional model comparison are not accepted by these six routine tests. Restoration does not authorize further inference.

PASS rendered reconnect continuity (root browser evidence): after restoration, closing/reopening the panel recovered all six prompts and receipts; original IZZY03 rendered paused. Evidence performance-checkpoint-live-browser.json. This used no additional inference. Independent SQLite pairs/receipts corroborate durable stored continuity; browser observation is root-owned.
