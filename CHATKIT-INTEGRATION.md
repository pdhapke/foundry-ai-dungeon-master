# ChatKit integration evidence

Date: 2026-09-30 (America/Chicago). This document records implemented integration checks; it does not claim live OpenAI inference.

## Dependency/runtime resolution

Python 3.13.1 located at `C:/Users/peter/scoop/apps/python/current/python.exe`. Repository-local venv created at `chatkit-server/.venv`. Official packages downloaded after authorized sandbox network escalation: `openai-chatkit==1.6.5`, `openai-agents==0.22.3`, `openai==3.22.1`, `fastapi==0.142.2`, `uvicorn==0.54.0`. Entire dependency resolution pinned in `chatkit-server/requirements.txt`. `pip check`: no broken requirements. Frontend official types `@openai/chatkit==1.9.0`; npm audit found zero vulnerabilities.

## Integration changes

- `shared/src/chatkit.ts`: context and callable trigger types plus frozen enrollment header constants.
- `server/src/config.ts`: interpreter, loopback sidecar port and durable conversation DB path.
- `server/src/index.ts`: Node-owned Python lifecycle, per-process internal bridge secret, existing Foundry enrollment validation, live GM/world check through preserved MCP, server-held authorization resolution.
- `.gitignore`, `.prettierignore`, `eslint.config.js`: ignore installed Python runtime artifacts.
- Module/package lock, Python requirements, environment example, README and configuration documentation updated.

## Checks

Final integrated `npm test`: 140 passing tests (7 bootstrap, 9 shared, 101 server, 23 frontend); focused gateway streams and auth tests use mocks. `npm run typecheck`: passed all workspaces. `npm run build`: passed all workspaces. `npm run check:manifest`: passed. `npm run lint`: passed after owner corrections. `npm run format:check`: passed repository-wide. Python unittest discovery: 7 passing tests covering actual ChatKit SDK process with mocked inference, same-thread history, SQLite restart/ownership, auth, SSE/dedupe, concurrent overlap rejection, cancellation guard release, and process-error guard release.

Commands run from `C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master`. Focused npm evidence initially captured in temporary local `tmp-chatkit-tests.log`; test summaries are recorded here without raw credential-bearing runtime logs.

## Live prerequisites

A running Foundry session authenticated as a GM, a ChatKit domain key registered for the exact browser origin, and an authorized OpenAI API credential/model are required for live streamed model verification. A subscription or a stored legacy OAuth token alone is not proof of API eligibility. Independent runtime QA will record which prerequisites actually exist and any exact remaining blocker.

Local provider configuration inspected without printing values: API key absent; explicit fallback disabled; model unset. ChatKit domain key presence must be checked in the live world by independent QA. No authorized live inference was attempted.

Final checks rerun after backend completion and explicit provider selection: all 140 npm tests, typecheck, lint, formatting, build, manifest, and 7 Python tests pass.

Explicit provider selection: set AI_DM_CHATKIT_AUTH=api-key together with enabled API-key configuration to bypass retained legacy authorization for ChatKit; existing remains the default and preserves its fail-closed policy. Code reference review confirms the ApplicationV2 ChatKit component is the active panel and explicit /ai, scene button, keybinding and application event all route through it. Retained WebSocket controller supplies enrollment authentication; obsolete model/event UI and automatic inference hooks are inactive.

## Authorized account sign-in correction

The user has now authorized the existing ChatGPT account sign-in route. The current README and environment example make `AI_DM_CHATKIT_AUTH=existing` the first option: Continue with ChatGPT, then select a discovered eligible model. The API-key path is optional and remains explicitly selectable. Earlier API-key-only prerequisite wording above describes the initial test configuration, not a requirement of the implemented account route. Neither subscription status nor a stored token alone establishes acceptance; live provider authorization and an incrementally streamed response still need verification.

Frontend account controls are being restored and backend request tests check the supported outbound request with `store: false`. These tests use mocked provider responses and do not establish live account inference. The running Foundry process has not been restarted by the integration worker; updated backend code requires a coordinated restart before live verification.

## Account-route integration checks

After restoring account controls and `ModelSettings(store=False)`: 141 npm tests pass (7 bootstrap, 9 shared, 101 server, 24 frontend). Typecheck, formatting, build and manifest checks pass. Documentation generation succeeds (2 registered HTTP paths, 10 bootstrap tool definitions). Python unittest discovery now passes 8 tests; the added test mocks the OpenAI HTTP transport and checks OAuth bearer use, selected model, `store: false`, streaming and supported serialized request fields. This is outbound request validation, not live provider acceptance. The new test-only frontend lint finding was corrected; repository-wide lint and formatting passed on rerun.

The restored controls are Continue with ChatGPT, Refresh status, Sign out and eligible ChatGPT model selection. They operate independently of ChatKit domain configuration, so account connection can be established while the domain key prerequisite remains outstanding. The genuine ChatKit component remains the only composer/transcript.
