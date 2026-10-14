# Solo DM implementation ledger

## Baseline and preservation
AI module original clean main `77b4516f5593b0bea6d914b6cad5c313bd7488c8`; matching parent gitlink; existing bare origin `.tools/git-remotes/foundry-ai-dungeon-master.git`. No initialization or remote changes. Parent/local-api unrelated dirt inventoried in `docs/baseline-evidence/`; preserved at the original final gate. Current intentional bridge additions are session/world document commands/endpoints/types/registrations plus prior transaction-origin forwarding. Native Git works; missing Git shell helpers are an environment limitation. Existing Izzy campaign untouched. No push, publish or deployment.

## Scope and authority
User requests constant DM identity, campaign overview/retrieval/proposals, on-demand trusted game control, triggers, and full verified GM authority over the active world and authored world files. Ordinary authenticated manual turns receive world role authority without an English verb whitelist. Typed adapters enforce world/revocation/state boundaries; destructive/ownership/executable changes have separate exact controls. Campaign canon must retain dedicated review and cannot be bypassed by file tools. No host/root/credential authority follows from GM world scope.

User chose configuration unchanged and offline implementation/tests only after direct-file privacy failure. Live model calls still require an explicit budget; activation/reloads/fixtures/world switching need approval. Private persistence remains fail closed without verified serving protection.

## Original phases and evidence
| Phase | Independent gate | Evidence/limits |
| --- | --- | --- |
| 0 baseline | PASS | baseline/phase0 reports; original 177 Node +14 Python; Git/dirt verified |
| 1 storage | PASS offline | real FS, second process, killed writer and retained oversized recovery regression |
| 1 deployment privacy | FAIL/BLOCKED | unauthenticated campaign Markdown HEAD HTTP200; no content read; no config changes |
| 2 overview/retrieval | PASS offline | overview/index caps, spoiler filtering, UTF8 bounds regressions retained |
| 3 authoring | PASS offline | exact digest approval, SQLite concurrency/recovery; receipt-overwrite regression retained |
| 4 initial catalog | PASS offline | real Python HTTP adapter contract with controlled MCP, not live Foundry |
| 5 panel/triggers | PASS offline | cancellation/Region API/remote hook fixtures; actual Foundry trigger gate unperformed |
| 6 original acceptance | PASS offline | AI223/Python25/related841; checks/builds; controlled realFS/SQLite joined journey |

Original reports `solo-dm-phase0` through `solo-dm-phase6-validation.md`, `final-evidence/`, and `solo-dm-acceptance-journey.md` remain historical. Initial dice/private-note subset is superseded by the following expansion; it does not prove full current coverage.

## Current expansion ownership and gates
- Root: gateway/index/Python prompt/health/build identity; new world-request and world-review; application/template/loaded marker; ledger. Prompt v6 single runner; Python26 PASS; root UI/types/lint PASS.
- Storage worker: catalog/native/session/pause/runtime; world-document facade and reviewed policy; automatic/Region marker integration. No raw unrestricted execution. World scope consumers independently validated offline.
- Privacy worker completed: frozen WorldFiles; bridge session repairs and world-document backend. Root now owns narrow executable-behavior backend repair.
- World-file adapter worker completed: new adapter/tests/report, ordinary role-bound writes and exact reviewed delete/recovery, default-deny private storage.
- Independent coverage validator: immutable regressions and capability-validation report; did not implement reviewed features.

| Expansion gate | Status | Evidence |
| --- | --- | --- |
| pause/runtime inspection | PASS source/offline | pause getter/setter exist live; old catalog filtered setter; actual old saved narration has no corroborating tool trace |
| audit/build identity | PASS offline | scope/redaction/cancellation/observer-failure/startup hashes regressions; running legacy health lacks new identity |
| routine actions | PASS offline | cycle/status record/provenance/combat successor repairs; independent tests and actual installed core API review |
| WorldFiles | PASS offline | actual FS/SQLite; recovery receipt transaction regression plus reconstruction/replay |
| world-file adapter/UI contract | PASS offline | 7 tests, real FS/SQLite, exact service review through UI validator, tampering/other GM rejected |
| world-document backend | PASS offline | executable behavior, binary hash, embedded-parent/list and actual backend → adapter → UI regressions retained |
| broad world catalog/facade/origin | PASS offline | full manual GM role, grant/schema checks, exact review, durable receipts and installed-source/fixture echo checks |
| final expanded acceptance | PASS offline | AI286/Python26; related full suite; lint/types/builds/manifest; inventory273=132 covered/equivalent/internal +141 explicit exclusions; preservation inventories audited; database filename drift and missing initial byte snapshots explicitly recorded |
| actual embedded chat/live privacy | BLOCKED | no model budget/activation approval; old running build cannot prove new source behavior; privacy remains failed |

## Shared contracts
World control: server-issued `{manualRequest:true,requestDigest}` only authenticated ordinary SDK input; automatic/custom/retry/reference-only inputs cannot mint authority. Session effect is distinct from read/presentation/proposal; grant validation precedes trusted authorization. No fake atomic CAS: expected-state preflight and authoritative postread; uncertain actions never blindly retry.
World document review: browser-only `{kind:'world',threadId,actionId,reviewDigest,decision}`; complete before/request/scope digest; durable pending/claim/receipt. World-file review same with kind `world-file`. Review digest uses deterministic codepoint sorting; document source hashes omit `_stats` and match backend canonicalization. Model has no approval tool.

## Blockers and next step
All expanded authorized offline features/checks are independently validated (solo-dm-expanded-evidence.md, capability-validation, final-evidence/expanded-ai-tests.txt). Private proposals and filesystem effects fail closed before persistence; independent late privacy callbacks at six checkpoints cannot write after cancellation. Complete browser review is96k, model results24k/arguments12k, file content12k, document source24k minus transport headroom. Concrete isolated fixture/activation and two-request model budget for actual embedded discovery → schema load → execution → authoritative read-back. Never count mocks, advertisements, or assistant narration as live execution evidence. No change to privacy/network configuration without separate explicit approval.


Final preservation audit: parent HEAD0aec2fc and AI main77b4516/gitlink/existing bare origin unchanged. Parent209/digital-tabletops4/Trails1 inventories match baseline; local-api retains78 initial entries plus15 intentional bridge/origin paths. dnd5e tracked statuses unchanged, but46 untracked LevelDB log/MANIFEST filenames rolled over; cause unproven. Initial evidence contains no byte snapshots, so exact byte preservation is not claimed. Current files retained; evidence final-evidence/expanded-*-dirty.txt. No task campaign/resource writes or live mutations occurred.

## Live pause and latency follow-up
User approved isolated activation/fixtures/world switching and two model requests (eight steps each); privacy/network configuration remains unchanged. No new model calls or mutations used in latency inspection. Existing embedded user turns independently show real first-request search/load/read/set/read, completed durable receipts false then true, and direct authenticated MCP read confirms paused=true. UI reports47s/38s; audited adapter spans18.372s/16.265s. Running health identity is now present, runtime260 tools. Evidence solo-dm-latency-live.md; source worker owns solo-dm-latency-source.md; separate validator owns solo-dm-latency-validation.md. Recommendations only, no latency code changes. Live pause gate PASS; broader isolated world-control/triggers/cancellation/privacy gates remain unperformed/failed as applicable. Next step: prioritize deterministic pause path plus shared call reductions, instrument before claiming speed gains.

