# Prompt 2/3 combined build and deployment gate

2026-10-04. Supersedes the build-held portions of `prompt3-implementation-handoff.md`.
The parent released Prompt2 source ownership and authorized combined validation/builds.
Combined source, compiled disk and offline gates pass. Runtime restart and real browser
acceptance remain blocked by unavailable supported desktop/browser control here.

## Final combined verification

Read `prompt2-resume-handoff.md` and Prompt3's implementation handoff before work.
Built MCP workspaces in shared/server/module order, then AI shared/server/module.
All builds passed. Both complete workspace typechecks passed; rebuilding shared
declarations resolved the earlier MCP `preparationGuard` typing dependency.
AI module manifest and MCP integration-manifest checks passed.

| Fresh aggregate suite | Passed | Failed |
| --- | ---: | ---: |
| AI bootstrap | 7 | 0 |
| AI shared | 9 | 0 |
| AI server | 431 | 0 |
| AI module | 92 | 0 |
| MCP bootstrap | 18 | 0 |
| MCP shared | 49 | 0 |
| MCP server | 536 | 0 |
| MCP module | 358 | 0 |
| Python full discovery | 164 | 0 |

Counts describe each suite; focused and independently imported fixtures overlap and
must not be added as distinct tests. Python ran with `AI_DM_CHATKIT_DATABASE_PATH=:memory:`
and an explicitly fake offline key. Logged model-request events are mocked fixtures,
not provider requests. A final unclosed in-memory SQLite ResourceWarning did not fail
the suite; no live campaign/transcript database was used.

Independent selected-model admission7/7 passed:19154permanent units,
22510realistic fixture,30tools,24576input ceiling,8192reserve. These are conservative
admission units, not billed-token measurements. No context limit, model, provider,
billing, inference allowance, automatic gameplay setting or approval policy changed.
Full suites include readiness/privacy/authentication/receipt/protocol and exact
approval tests. Independent source review found browser/DM origins remain distinct:
DM requests cannot authorize publication, local map disclosure/import or native scene
application. Prompt3's generic `/actions` review cannot grant `/preparation` authority.
The resumed preparation publication/native browser review UX is not supplied by that
generic action drawer and is not browser accepted by this pass.

One supporting diagnostic repair was necessary: MCP startup identity now includes
`server/dist/endpoints/world-documents.js` and `shared/dist/world-documents.js`,
covering the new preparationGuard schema/contract. This changes identity metadata
only, not any handler or authority. MCP server rebuilt cleanly after this addition.
Independent compiled-disk review confirms AI74 and MCP17 required artifacts, all
present and matching their captured SHA256 bytes.

Private aggregate logs and read-only runtime evidence:
`C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/prompt3-combined-evidence/`.
Includes AI build/typecheck/tests, MCP typecheck/tests/identity-build, Python tests,
manifest checks, runtime identity and process/listener/lock summaries.
Independent report: `prompt3-combined-independent-gate.md`.

## Actual runtime, privacy and readiness

Fresh read-only health/hash check after the final builds:

| Service | Actual load versus current disk |
| --- | --- |
| AI | Startup2026-10-04T02:33:19.759Z;53startup entries,44match; current required74,21absent from old startup manifest; requests0 |
| MCP | Startup2026-10-04T02:33:19.380Z;15startup entries,14match; current required17,2absent from old manifest |
| Python | Loaded app digest differs from disk; promptv9, normal15turn limit |

Liveness health saying ready/ok is not combined-load or campaign readiness.
The existing stack is still Foundry30000/PID47912, MCP3939/PID2276,
AI3940/PID13536, Python3941/PID45948. `Data/Config/options.json.lock` exists.
Known terminal minttyPID23132 remains; this session's process inspection cannot
expose/verify its user-visible window. It reports main-window handle0, which does
not establish that the physical terminal is absent.

The authenticated supported `foundry_get_status` returns NOT_CONNECTED:
no opted-in client is connected on the requested bridge lane. Therefore exact
current GM/world `/prepare`, campaign retrieval and native/browser identity cannot
be checked live here. The historical last designated tab was locked setup; this
pass makes no fresh screenshot or browser-state assertion.

Anonymous Range probes to former `secrets-tracker.md`, public `overview.md` and
both legacy public transcript URLs return404, with response bodies neither read nor
printed. The private campaign root exists outside public Data. Public campaign
contains86asset files and0Markdown files; no authored source was restored publicly.
Existing asset disclosure/player secrecy was not comprehensively audited here.
Actual private canonical `overview.md` and `index.md` remain absent. Source-backed
review drafts remain private/unpublished; readiness and factual currency require
their separate human review/publication. No live map imported, scene applied or
activated, gameplay state changed, account changed, model submitted, embedding/image
generated, service separately launched, push or publication occurred.

## Exact remaining deployment and acceptance steps

No callable trusted node_repl/browser/desktop tool is exposed in this environment.
The installed browser and Computer Use packages require that trusted service.
No access denial was bypassed, custom terminal input used, process killed, lock
deleted, hidden stack launched or duplicate instance started.

1. In the **existing visible foreground Foundry Git Bash terminal** (known mintty
   ownerPID23132), press Ctrl+C once. Wait for Foundry shutdown success and the
   interactive shell prompt. Preserve that window and logs.
2. Report that shutdown is complete so the parent/deployment owner can verify the
   four listeners are gone, stack processes exited and options.json.lock is absent.
   If a process/lock remains uncertain, stop and inspect; do not kill/delete it.
3. Run the existing `foundry` alias from `C:/dev/FoundryVtt` in that visible shell.
   Its verified definition is
   `node "C:/dev/foundryvtt/App/main.js" --dataPath="C:/dev/foundryvtt/Data"`.
   Leave foreground startup/error logs available. If the original shell exited,
   today's authorization permits a replacement visible persistent Git Bash while
   preserving the old log window; no separate component launches.
4. Re-run `node scripts/prompt3-combined-runtime-check.mjs` from the AI module to
   verify all74AI/17MCP startup artifacts match disk and Python digest matches.
   Service requests must stay0; no inference is needed for this check.
5. Use the existing intended browser session; unlock setup/launch izzy-campaign/
   join the GM if prompted. Verify exact opted-in GM identity before any `/prepare`
   read. The loaded browser AI marker must be
   `game.modules.get('foundry-ai-dungeon-master').api.build.compactPanel === 'prompt3-v1'`;
   server startup bytes alone do not prove browser/native handlers loaded.
6. Through supported browser/desktop tools, capture current compact UI at normal
   and compact viewport sizes, check signed-out/expired/model/domain/disconnected
   corrective states, keyboard menu/Stop/approval reachability, transcript scrolling,
   composer overlap/clipping and native ChatKit Stop. No live model submission or
   campaign mutation is needed for initial acceptance. Historical/source620x720
   dimensions and reduced host minimum280to120px are not measured pixel gains.

Actual before/after screenshots and matching-viewport usable-space delta remain
unavailable; do not fabricate them or relabel fixture/source evidence as live UI.
Stop for Peter's visual feedback after that gate. This does not complete all four
efforts: source-backed canon review and live speed/narration/player/TV/map acceptance
remain separately gated. Any live inference/generation still requires its own exact
budget and stop conditions.
