# Core routine command rollout ledger

User approved continuation after manually observing pause/unpause felt faster. This is qualitative acceptance of expansion, not numerical latency evidence. October 1, 2026 client date.

Phase: 4 inventory/contracts -> 5 staged command families -> 6 live or manual performance acceptance.

Ownership:
- core_ai: Python first-turn tools and AI TypeScript services, implementer tests.
- core_mcp: MCP shared schemas, command handlers/endpoints, implementer tests.
- core_validator: independent *core-rollout.validation* tests and docs/core-rollout-validation.md, starting-state capture.
- parent: docs/core-rollout-ledger.md and acceptance/checkpoint documentation.

Contracts pending inspection of current code/schemas. Freeze cross-module contracts before edits. Preserve existing pause controls and all unrelated dirty work. Parent reread REPOSITORY.md; no AGENTS.md found in workspace recursive scan. Actual MCP module: Data/Data/modules/foundry-local-api. No Git resets, reinit, remote invention, pushes or deployment.

Required gate per family: immediate typed availability plus backend current GM/world authority, strict validation, ambiguity handling, stale/deleted targets, ordering, durable duplicate/uncertain handling, origin suppression and authoritative result. Bound multi-target operations with explicit partial outcomes; no false atomicity. Dynamic discovery remains for uncommon supported tools. Cache identity invalidation covers world/system/server/schema/permission; cache never authorizes execution.

Live budget/fixtures: requested asynchronously for at most 6 embedded-chat requests, up to 4 model requests each, reversible dedicated test scene/actor/combat only. Pending answer; do not run live calls or mutate fixtures without approval. Offline work continues. No automatic reload/restart authorization inferred.

Evidence: prior pause docs/pause-experiment-* remain intact. New starting snapshots and stage test reports under docs/core-rollout-evidence/. Workers return compact findings/evidence and completion notifications; no continuous polling.

Next: receive actual capability inventory and frozen typed contract proposal, review exclusions, implement independent-gated families, build both modules and report honest live/unrun acceptance. Numerical targets will be based on measured samples/user feedback, not promises.

## Approved continuation and frozen core proposal
User approved live budget and dedicated reversible test fixtures: maximum 6 embedded-chat command requests, maximum 4 model requests each. No calls yet. Parent will coordinate after independent gates.
Six individual typed immediate tools: move_token(scene_id,token_id,x,y), set_door_state(scene_id,door_id,state closed/open/locked), set_actor_hp(scene_id,actor_id,value), set_actor_condition(scene_id,actor_id,condition_id,active), advance_combat_turn(scene_id,combat_id), set_initiative(scene_id,combat_id,combatant_id,value). Existing pause, bounded scene/actor/campaign reads and dice retained. Backend-derived stable request IDs preferred. MCP fixed discriminated confirmed-action protocol six existing session kinds plus dice.roll formula; never arbitrary document/code execution. HP dnd5e only. Skill/save/attack/system actions require actual schema-backed support or explicit discovery exclusions.
Caching: reviewed contracts compiled/versioned rather than dynamic unchecked schema cache. Execution handshake + live auth every request; no new campaign context cache without revision evidence. Validators must test drift/world/system/permission/reconnect.

## Independent stages (ongoing)
First fixed core service source/unit gate: independent AI3, MCP command3/endpoint3 PASS; discovery/catalog16 and mocked origin/hooks8 PASS. First-turn bounded play-state reads expose IDs/current system trusted roll keys without schema discovery. HP limited dnd5e; typed ability/save/skill rolls added through actual supported dnd5e APIs, specialized Trails/attack/item/rest remain discoverable with policy checks.
Schemas: versioned compiled core-actions-v1 handshake rejects drift; no mutable dynamic availability cache. Stable overview parsed cache validates source content hash plus world/sourceURI/permission revision on every use, process startup resets. Live world/doc context never cached for execution authority.
Direct /ai-control typed grammar and model calls share authenticated /actions/native core service and world queue. Model request limit AI_DM_CHATKIT_MAX_TURNS1..8 defaults8; acceptance launch must set4.
Known concrete combat.next semantic defect found by MCP implementation review (literal indexed update vs Foundry nextTurn skip defeated/world-time behavior); repair required before final gate.

## Approved live fixtures
Created only inactive namespaced test scene/Actor/token/door/Combat via existing authenticated SDK. Manifest docs/core-rollout-evidence/live-fixture.json records exact IDs and original active scene/pause/combat for restoration. No model calls yet, no activation or original campaign mutations. Script scripts/core-rollout-fixtures.mjs handles explicit setup/activate/restore/inspect and keeps exact fixture records; no deletion.
Read-only actual runtime Foundry14.368 dnd5e6.0.3 GM only, selected UI model gpt-5.6-sol. Initial connector MCP session was stale; existing application SDK transport successfully reinitialized, no credentials printed/config changed. Current source build identity core-actions-v1/Python solo-dm-v8-core-actions pending reload.

## Live phase 6 evidence
Approved6 embedded requests consumed exactly6, configuredgpt-5.6-sol reasoningnone, each2 modelrequests1 typedtool no discovery (12model6tool total). Loaded Node policycore-actions-v1/Pythonpromptsolo-dm-v8-core-actions hashverified beforecalls. Independent canonicalreads+SQLite receipts all6 confirmed. Times gatewayarrival->authoritative toolresult: unpause4.515s (canonicalpause observed4.473s), door3.709s, move4.336s, skillroll6.746s, HP5.949s, combat5.526s. Gatewayfinalstreamend6.605/5.937/6.512/9.054/8.042/9.250s. Browser paint not measured. First unpause coldprocess/modelconnection; later warmprocess mixed contextpaths; one sample per family, no statistically meaningful familymedian/tail. HP/roll/combat detailed wordings stillfullcontext with1.5-3s preparation; candidate speedwork later. No numerical target agreed yet.
Artifacts: docs/core-rollout-evidence/live-traces.json, live-receipts.json, independent-live-final-inspect.json, independent-live-receipts.json, loaded-build.json. Runtime readinventory originally namedruntime-before.json was refreshed afterreload; renamedruntime-loaded.json to avoid claiming beforeinventory. Initial readonlystatus remains transcript only.

## Direct shortcut repair
Live shortcut attempt exposed Foundry14 richtext envelope beforechatMessage parse. Minimal browserhooksnormalize safe single<p>/br/entities only, reject rich/executable tags. Module build/typecheck/focusedtestsPASS; independent gatepending/liveinference-free testpending. Sixmodel acceptance not rerun and no further modelcalls approved. Browser-only changedbundle means old Node startup snapshot correctly retains oldhash until finalnormalreload.

## Runtime reload
Worldclosed normally viaMainMenuReturntoSetup thenserverShutDown. Existing launcher nodeApp/main.js--dataPath restored; setupadminprompt required supported--world=izzy-campaign autolaunch to restorealreadyapprovedworld, no credentialchanges. Setup-only restart hitstartupfilelock once; supportedstaleexpiry allowed cleanretry, no filedeletion. AcceptanceenvAI_DM_CHATKIT_MAX_TURNS=4. Finalnormalreload will remove temporaryguard, preserve originalscene/pause/combat, and verify finalhashes. No pushes/Gitresets/remotes.

## Final gates
Independent implementation and live six-command gates PASS. Direct shortcut confirmed with zero additional inference; safe Foundry 14 envelope repair independently passed. Dedicated fixture values restored, original campaign restored, fixtures retained inactive. Final normal runtime launched without the temporary four-turn acceptance guard; configured default remains eight. Approved model budget fully consumed: six messages, twelve model requests. See core-rollout-acceptance.md for measurements and limitations. No further command families or speed work started.
