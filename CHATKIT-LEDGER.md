# ChatKit implementation ledger

## Objective and status

Deliver an embedded genuine OpenAI ChatKit panel: streamed manual chat and a Foundry programmatic trigger sharing the intended conversation. Investigation in progress. Existing unrelated working-tree changes must be preserved.

## Ownership

- Orchestrator: this ledger, architecture decisions, integration contract, assignments and acceptance.
- audit: CHATKIT-AUDIT.md; repository/lifecycle/failure/MCP investigation only.
- architecture: CHATKIT-ARCHITECTURE.md; official protocol/SDK/auth investigation only.
- Frontend/backend/configuration ownership will be assigned after contract approval by orchestrator.

## Architecture and contract

Pending focused investigations. Long-lived credentials remain server-side. Player-visible context must exclude hidden GM data. Game content and tool output are untrusted.

## Verification

Not yet implemented or verified. Build/mocks will be distinguished from real Foundry/API runtime evidence.

## Next actions

Receive investigations; record supported architecture and shared contract; assign disjoint implementation ownership; integrate; independent runtime QA.

## Architecture decision / shared contract (milestone 1)

- Genuine custom ChatKit: official CDN web component -> existing Node gateway POST /chatkit -> loopback Python openai-chatkit ChatKitServer.process. Gateway forwards supported JSON/SSE without inventing a protocol. Python executes model through server-held authorized OpenAI API credentials.
- GM-only milestone: backend verifies existing enrollment/session identity and GM role. Players receive 403; no GM conversation or context is delivered to them. No new OAuth infrastructure. Existing MCP bridge/catalog remain intact; future tools attach through a server-side extension point.
- Panel mounts one web component in Foundry Application lifecycle, removes listeners/aborts outstanding requests on close, and reuses persisted thread pointer on reopen. Scope thread ownership and pointer by verified worldId + userId; persist thread/message records server-side and verify every thread operation.
- Manual composer and callable app trigger use the same mounted component/thread. Public trigger takes prompt, bounded context, requestId; supported ChatKit sendAction type foundry.context-response with payload {requestId,prompt,context}. Initialize thread through supported API when needed; reject conflicting active request, deduplicate repeated IDs with bounded TTL, limit payload lengths. No automatic inference loops.
- Node custom fetch authentication reuses existing sessionCredential/clientId/moduleVersion boundary; secrets never in model context/logs. CORS/origin policy follows existing local gateway. Python accepts only gateway-authenticated loopback traffic with server-only principal metadata, never browser role claims.
- Context is a documented allowlist of relevant visible game metadata, not arbitrary hidden journals. Authorization precedes extraction; browser-supplied content/tool output is untrusted data, never instructions. Frontend labels transmitted context.
- Streaming cancellation propagates disconnect/abort; busy, auth, configuration and network errors surface clearly. Cancellation must release overlap guard; repeated panel opens do not register global hooks repeatedly.
- Configuration/startup: integration owner documents Python runtime/dependencies, loopback port/internal bridge credential, API key/model and existing Foundry child-process startup. Missing authorized credentials block live inference only; mocks are labeled.

## Implementation ownership / progress

- audit -> frontend: module/src, module/templates, module/styles and focused frontend tests.
- architecture -> backend: server/src/chatkit (new), server/src/app.ts route wiring, chatkit-server implementation/tests (excluding requirements/config).
- integration: shared contracts, package manifests/lockfiles, server/src/config.ts + config tests, environment examples, startup scripts, Python requirements, README; subsequent integrated verification.
- Orchestrator retains ledger. Workers coordinate exact shared types directly; material deviations require reporting.

## Evidence

- CHATKIT-AUDIT.md and CHATKIT-ARCHITECTURE.md: investigations in progress.
- CHATKIT-INTEGRATION.md: integration verification pending.

### Frozen gateway header names

ChatKit custom fetch sends x-ai-dm-session, x-ai-dm-client, x-ai-dm-version. These reuse the verified enrollment boundary; backend must enforce GM identity before proxying. The session credential is runtime enrollment material, never an OpenAI API key.

### Investigation verification milestone

Repository baseline: typecheck and 131 deterministic tests passed; no prior live model response verified. Audit established custom WS terminal-only output and per-run history loss. Official architecture established Python SDK requirement. Python 3.13.1 available; ChatKit SDK installation pending. Read detailed evidence in CHATKIT-AUDIT.md and CHATKIT-ARCHITECTURE.md.

Contract correction: custom fetch also sends x-ai-dm-browser-session, using existing browserSessionId. Backend preserves existing session binding; authentication must not weaken it.

SDK correction: installed component types specify sendCustomAction (not older sendAction examples) and require public api.domainKey. Use installed supported method. Backend empty-thread bootstrap persists official Store thread for first programmatic trigger; both entry points then share it. Domain-key configuration is public, not an API credential. Exact supported configuration/startup documented by integration owner.

Integration checkpoint: pinned Python openai-chatkit 1.6.5 / agents 0.22.3, JS ChatKit types 1.9.0. Initial integrated typecheck passes; 138 deterministic Node tests pass (7 bootstrap, 9 shared, 101 server, 21 frontend). Backend Python and independent real runtime verification pending. These passes are not live inference evidence.

## Implementation milestone

Frontend and backend owners report complete. Active custom composer/transcript/OAuth/model/proposal UI replaced by official web component; automatic inference hooks removed. Existing authentication, MCP transport/catalog and legacy service tests preserved. Public API: game.modules.get("foundry-ai-dungeon-master").api.trigger({prompt,context,requestId}); GM scene control or Ctrl+Shift+D opens panel.

Backend verification: 4 gateway tests and 7 Python tests pass. Python tests use actual SDK protocol and SQLite storage with mocked inference; include continuity, principal ownership, overlap and cancellation. Initial integrated Node suite 140 tests passes with build/typecheck/lint/manifest. Final integrated check and independent QA pending.

Known live prerequisites: local OPENAI_API_KEY absent, explicit API fallback disabled, model unset. QA checking Foundry configured runtime and domain key. No credentials created, billing changed, push or deployment performed.

## Final independently verified status

Implemented: genuine Python ChatKit custom backend, embedded official component, shared manual/programmatic conversation, authenticated GM-only scope, persistence, bounded triggers, cleanup/cancellation and future tool extension. Active failed custom chat UI replaced; MCP retained.

Final integration: 140 Node tests and 7 Python tests pass; typecheck, lint, format, build and manifest pass. Mock inference is explicitly labeled. Independent QA confirmed Foundry V14.368 startup, three healthy companion services (HTTP 200) and unauthenticated ChatKit rejection (401). See CHATKIT-QA.md and CHATKIT-INTEGRATION.md.

Live inference/panel acceptance remains blocked: Foundry administrator login/no launched world/no authenticated GM browser, absent authorized API key/model configuration, and valid public ChatKit domain key not verified. Explicit AI_DM_CHATKIT_AUTH=api-key supports selecting API credentials without changing retained legacy authorization; requires AI_DM_ENABLE_API_KEY_FALLBACK=true. See README setup.

User requested shutdown of QA-started runtime to start/login personally. QA stopped only its Foundry process and descendants and verified ports 30000/3939/3940/3941 stopped. No runtime currently left by QA. Next action: user starts Foundry and logs in/launches world; resume independent panel and live provider acceptance once authorized API/domain configuration is ready. No push/deploy/billing changes.

## Resumed GM runtime QA

User launched Foundry and logged in as GM. Independent QA verified actual panel mounts at http://localhost:30000, close/reopen yields one panel, context/cancel buttons do not crash, and missing-domain-key error is visible. Settings > Game Settings > AI Dungeon Master > ChatKit domain key is empty. Server API key/model/auth/fallback configuration remains absent. No real inference could be attempted. See CHATKIT-QA.md for updated evidence. User-owned runtime remains running.

Next action: configure accepted public domain key covering http://localhost:30000 and authorized server API credentials/model (README). Restart normal Foundry runtime to reload server configuration; reopen panel. Resume live incremental manual response, app trigger and conversation continuity acceptance afterward. No domain key invented or external registration performed.

## ChatGPT plan authorization follow-up (authorized)

User requested ChatGPT account sign-in instead of separate API key, then authorized implementation. Current official SIWC docs explicitly support eligible local/open-source apps using authorized OAuth tokens for plan-backed Responses. Prior API-key-only blocker wording was too strong; eligibility/consent and registered UI domain remain prerequisites.

Ownership reused: frontend restores small Continue with ChatGPT/status/model controls using retained controller; backend verifies OAuth contract and explicit store=false plus outbound SDK request restrictions; integration updates setup/config/evidence and runs checks. Official evidence: https://developers.openai.com/siwc/quickstart and /siwc/token-sharing-open-source/models-and-inference and /preview-limitations.

Contract: retain genuine ChatKit custom backend, OAuth token remains server-side, full locally persisted history in input with stream=true/store=false; no forbidden continuation fields. Do not recreate competing chat UI or new OAuth infrastructure. User completes browser sign-in/consent. Independent QA follows after integration; user runtime must remain under user control.

## Account-route implementation and QA correction

Implemented Continue with ChatGPT/status/model controls independently of component readiness. Python requests explicitly set store=false; actual SDK serialization test verifies OAuth bearer, selected model, full history and stream=true with forbidden fields absent (mock HTTP). Returning OAuth callbacks now support omitted repeated client_id and reject mismatches.

Independent real GM QA resolved existing authorization with selected gpt-5.6-sol: API key absence is NOT a blocker for this route. Official JS quickstart documents local-dev; exact loopback origins now use that default (configured key wins, other origins require registration). Actual CDN composer mounted and reported domain verification skipped for localhost. Added loopback-scope regression test and unselected-model placeholder. Fixed unrelated iframe messages accessing Foundry settings before initialization.

Latest checks: 103 server tests, 25 frontend tests, previous unchanged 7 bootstrap/9 shared tests; 8 Python tests. Typecheck, build, lint and manifest pass; evidence formatting corrected. Inference/HTTP serialization tests are mocked. Actual startup/auth/selection/component mount verified, real streaming still pending. User was asked to restart backend for latest plan fixes; runtime became offline during that restart. Do not interfere with user-owned runtime. Next: user logs back in as GM, independent QA attempts real manual/button streaming and continuity.

## Live failure diagnosis / next restart

Real manual composer failed before any assistant delta or SQLite thread creation; context bootstrap appeared stalled and repeat was blocked by busy guard. No live success claim. Root fixed error status being overwritten by response.end and added preparing status. Backend added bounded native MCP verification timeout/cancellation (10s), sidecar header wait (15s), and aggregate /health request stages/error codes without content/credentials. Focused gateway/app checks7, typecheck, lint and server build pass.

Latest builds ready; user asked for one restart/login to load diagnostic backend. QA will compare safe stages and frontend request header names (temporary console diagnostic, values/body omitted); remove temporary frontend logger once diagnosed. Actual CORS cause not established; no guessed allowlist expansion. User-owned runtime must not be stopped by workers. Required next: restart confirmation, diagnose exact stage, evidence-based fix, actual manual/action continuity acceptance.

## Live milestone achieved

Independent QA verified real provider inference through genuine CDN ChatKit using existing ChatGPT plan authorization. Manual text grew incrementally across rapid snapshots while Receiving/Stop active, then completed. Foundry context button responded in the same conversation with current scene metadata; prior marker and scene survived follow-ups and close/reopen. Busy rejection, cancellation, recovery response and unauthenticated gateway401 passed live. User runtime remains running.

Evidence-driven fixes: exact native frame correlation header caused CORS preflight-only failure. Backend explicit allowlist/test corrected; custom fetch omits the correlation header already discarded by our proxy, keeping protocol/auth body untouched. Temporary request-shape logger removed. Avoided force re-render of mounted iframe in open/trigger to preserve thread. Regression checks protect native frame preservation and fetch body/auth behavior.

Verification: latest104 server tests +25 frontend tests pass, unchanged7 bootstrap/9 shared previously passed; 8 Python SDK/persistence/inference mock tests passed independently. Typecheck, lint, formatting, build and manifest pass. Live MCP current-GM verification exercised by successful gateway requests; general tool execution/catalog remains covered by deterministic tests, not newly live exercised. Auth refresh/new consent and arbitrary outage injection not fully live exercised; no claim otherwise. See CHATKIT-QA.md.

Next actions: milestone complete; no external blocker for core flow. Future tools can attach through existing server-side extension point without MCP redesign. Latest backend CORS allowlist is built and loads on next normal restart; current runtime works through tested custom fetch override. Empty QA thread from failed remount retained alongside successful test conversation; no deletion/world mutation. No credentials created, billing configuration changed, push or deployment.
