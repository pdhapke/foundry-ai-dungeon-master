# Phase5 AI perception inventory and contract gaps

## Ownership and evidence

Read root REPOSITORY.md; current dirty/untracked inventory saved in phase5-start-ai-inventory.txt before edits. Allowed production files: AI server/shared/Python perception integration after agreement with native worker. No frontend application/recovery edits. No inference, provider changes, server lifecycle actions or live fixtures. Applicable historical evidence:attack-vision-validation.md and attack-vision-evidence/live-results.md. Historical native player rendering passed bounded door/movement/light/fog examples; structured visibility was blocked by NOT_CONNECTED. These reports are not current runtime or broad vision-mode acceptance.

## Current source observations

MCP scene-render endpoint routes to selected effective user's connected opted-in player lane with isGM=false; a separate opted-in GM requester supplies command authority. Missing player does not fall back to GM. Native inspector checks exact user/loaded scene/token ownership and computes player-visible entity IDs, isolation/environment statuses, redaction, persistence before/after hash, fog revision and bounded evidence. The visibility response itself lacks capturedAt/client identity/freshness challenge metadata; the image response has capturedAt.

AI read-tools token_perception checks selected identifiers, selectedUser/selectedToken/tokenOwned/sceneLoaded true and six required redaction flags. It then passes arbitrary issues, selectedContext, isolation and environment objects/status through. This permits extra fields/prompt-like issue text in adapter responses and loses persistence/bounds/fog evidence. No explicit local unavailable/stale result exists; disconnected bridge errors throw instead. IDs are sliced to64 without validating identifier grammar or exposing truncation. No AI perception-specific tests found in current server suite.

Python exposes typed foundry_read_token_perception through the authenticated adapter and describes connected opted-in non-GM visibility only. It is read-only and cannot release the Phase3 mutation slot. Permanent DM policy forbids narrating hidden enemies from GM context, but ordinary GM initial context, campaign/history and other GM tools remain available. Prompt instructions alone are insufficient proof of hidden-safe player-facing narration. No separately approved inference is available for narrative acceptance.

## Contract to agree before editing

Require explicit selected player/token/scene identity plus native readiness/opt-in/nonGM/client identity, observation/revision consistency and supported vision isolation metadata. Use strict allowlisted projection with typed issue codes (no arbitrary source messages/subject IDs), bounded validated player-visible IDs and explicit truncation. Stale/unavailable/incomplete must disclose no player-visible entities or substitute GM data. Preserve native perception updates for movement/door/lighting without inference. Define how missing revisions, reconnects/missed notifications/changed scenes revoke report usability; do not cache mutable reports across turns.

Native worker and independent validator are coordinating the exact response envelope. Implementation gate pending contract; model-free native reporting/browser readiness comes first. Player-facing narrative acceptance requires an independently authorized context/output boundary and separate inference budget, not a hidden keyword classifier or a new provider.


## Implemented narrow contract

Agreed native observation v1 contains UUID observation ID, exact world/scene/user/token, nullable actorId, server-bound clientId, isGMfalse/optedIntrue, capturedAt, stateRevision, readiness, basis request-local-native-render-flags and nullable pendingRenderFlags. MCP rechecks exact connected target identity/consent after native read; native rechecks world/user/token ownership/context and persistence. This is request-local evidence, not a cached authority grant or universal scene epoch/paint proof. Client wall timestamps are not used as a freshness clock.

New server/src/chatkit/player-perception.ts uses typed Zod allowlists. It validates exact selected IDs/world, privacy flags, nonGM/optin metadata, hash consistency, zero pending flags, complete isolation/vision/fog/lighting/darkness and nontruncated bounds. Any nonempty native issues, incomplete status, missing signal, malformed IDs/revision or unsupported evidence yields unavailable with no entity claims. Pending render, explicitly stale observation or persistence drift yields stale with no claims. Unknown source objects/extra fields, raw issue messages/subject IDs, hidden-source counts, arbitrary environment/context fields and unrestricted GM fields never pass. Only64 validated IDs per kind are supported; excess results fail closed rather than silently implying complete coverage. No cross-turn perception cache is added.

Production wiring gap found independently of historical NOT_CONNECTED: readCatalog uses CHATKIT_READ_TOOL_METADATA, which omitted foundry_get_token_visibility. Added only this bounded GM-authorized read descriptor, preserving metadata policy and fresh pre/post execution authorization. read-tools catches bridge availability errors into content-free typed results; authorization revocation and cancellation still deny the run. Python continues the existing authenticated adapter and explicit status semantics; its tool description identifies request-local evidence and disclaims a player-safe model-context guarantee. No new model route/classifier or frontend application feature was introduced.

Startup build identity now includes server/dist/chatkit/player-perception.js and changed server/dist/tool-catalog/metadata.js, captured once through the existing startup mechanism. Python app digest remains startup-local. Source/build preparation does not update loaded services; the orchestrator owns manual restart and loaded identity verification.

## Validation and files

Focused AI7 PASS; combined independent projector2 + own7 =9 PASS. Actual adapter tests cover production allowlist dispatch, selected arguments only, disconnect/unavailable, pre/post revocation and no raw error/source issue injection. Projection tests cover hidden fields/counts, malformed/missing metadata, world/user/token/scene context, hashes, nonGM/consent, pending signals, incomplete/truncated results and no GM fallback. Python focused2 PASS; full Python95 PASS in58.475 seconds. All AI workspace typechecks and server-only build PASS. Final full server suite292 PASS in16.796 seconds. An initial evolving independent fixture test supplied contradictory failure issues for a complete projection; current combined9 and full292 passed after fixture alignment. No baseline implementation failure identified.

Production changed files: server/src/chatkit/player-perception.ts (new), server/src/chatkit/read-tools.ts, server/src/tool-catalog/metadata.ts, server/src/build-identity.ts, chatkit-server/app.py (tool description only). Tests: server/src/chatkit/player-perception.test.ts and chatkit-server/test_player_perception.py; independent validator owns phase5-independent-perception.test.ts and its Python validation. No frontend files edited. Evidence: phase5-ai-focused-tests.txt, phase5-ai-typecheck.txt, phase5-ai-build.txt, phase5-ai-server-all-tests.txt, phase5-python-focused-tests.txt, phase5-python-all-tests.txt.

## Acceptance boundaries

Structured selected-player reporting and native rendering are model-free live gates owned by the orchestrator/native worker. Latest historical bridge disconnection remains distinct from the repaired AI allowlist wiring. Native query points/elevation, walls/path/regions/vision-mode correctness are separately validated; this AI projection exposes safe entity IDs/environment/observation metadata, not unrestricted coordinates, raw Region behavior or path planning. Source/fake tests do not prove actual player rendering or remote readiness.

Player-facing model narration privacy: BLOCKED until a proven context/output boundary and separately approved bounded inference. Ordinary authorized GM DM context/history/campaign/tools are deliberately preserved, so prompt warnings alone do not isolate hidden information from a model asked to narrate a player view. No inference, fixtures, settings/provider changes, or service lifecycle work occurred here.

Final prepared SHA256: player-perception.js0388400870beaadff9f19050d0f40f42628e06c59d158cb8a28e5a4aecda9a91; metadata.js e6c0e57681ac102aa894726a3aabb50a81d4d105b3e22d72c7e56a0565a128c0; Python app.py c22c45bac820489819bb0460a9c5963f05ad803040aec5d963770e5ab68511d9. These are disk artifacts, not loaded-runtime observations.
