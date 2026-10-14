# Approved narrow resource retest scripts

Prepared offline only. Do not run until root confirms the user-managed manual restart, independently verified loaded repaired native bundle and Python cap3/retry0.

1. phase4-live-resource-retest-capture.mjs: fresh authenticated MCP reads; captures new original scene, pause/combat, HP/temp, source items/tokens and automaticEvents. No settings changed.
2. phase4-live-resource-retest-setup.mjs: exact world/user/dedicated fixture +freshness +automaticEvents=false checks, activates only approved scene and creates one new finite-use fixture item; writes separate retest-fixture evidence. Does not alter existing actor mechanics.
3. phase4-live-resource-retest-native.mjs: exactly one fresh single resource sequence and its exact duplicate (2 deliveries); counts prior3 plusnew2 against approved total5. Uses fresh UUIDs and never references failed action IDs. Durable local dispatch count claimed before sending. Stops on uncertain/nonconfirmed outcomes without retries/inference. Resets fresh target HP/temp and newitem spent0 after success before embedded work.
4. phase4-live-resource-retest-restore.mjs: remove exact phase4 flagged new item, restore fresh original active scene and HP/temp where needed, verify actor HP, scene/pause/combat/token positions and unchanged automaticEvents=false. Never touches audit ledgers or memory fences.

All new evidence uses phase4-live-resource-retest-* names, preserving first attempt, rollback and terminal reconciliation evidence. Syntax checks PASS4. Scripts do not launch, stop or restart services. Two embedded prompts/max6application modelrequests remain root-owned and unconsumed.
