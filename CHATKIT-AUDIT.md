# ChatKit repository audit

Audit date: 2026-09-30. Scope: read-only investigation of existing implementation; only this evidence file written.

## Instructions and ownership

No AGENTS.md exists in C:\, C:\dev, repository root, or target package hierarchy (recursive search). REPOSITORY.md is applicable operational guidance: preserve excluded runtime/world databases and credentials, preserve independent child repositories, use normal Foundry process-tree startup. Existing target docs/live-validation.md contains historical inference approval language; current user authorization governs this task. Root working tree contains extensive unrelated modifications; the entire AI DM package is preexisting/untracked. Do not reset/delete it.

## Stack and lifecycle

- Target: Data/Data/modules/foundry-ai-dungeon-master. Manifest requires Foundry 14; REPOSITORY.md and docs/live-validation.md identify installed build 14.368.
- TypeScript workspaces shared/server/module; Node >=24. Server Express 5 + ws + SQLite; frontend esbuild ESM bundle + ApplicationV2/HandlebarsApplicationMixin. Locked OpenAI JS SDK 6.49.0, MCP SDK dependency ^1.31.0. No ChatKit package/import/endpoint exists.
- module/src/index.ts registers settings/keybinding/hooks at init; controller connects at ready. hooks.ts adds scene-control opener, slash command and opt-in automatic events. application.ts subscribes to store, rerenders custom transcript, unsubscribes on close. Opening the panel creates a singleton application.
- scripts/foundry-child-bootstrap.mjs and installed Foundry hook start existing Node AI service at loopback 3940 after local-api 3939. Preserve process-tree broker.
- Commands: npm run build; npm run typecheck; npm test; npm run lint; npm run check:manifest. Workspace frontend tests use node --import tsx --test, backend similarly. Normal startup documented in REPOSITORY.md and docs/configuration.md.

## Failures and evidence

1. This is not ChatKit: application.ts/templates implement a custom form/transcript and transport.ts uses bespoke aiDm WebSocket messages. No supported ChatKit component or custom-backend protocol is present.
2. Incremental output is absent in production: server/src/runner/openai-provider.ts consumes SSE through terminal response.completed but exposes no output_text.delta callback. runner.ts emits onOutputDelta only after parsing complete run_complete.finalText. UI has delta machinery, but its production input is one final chunk.
3. Conversation continuity is missing from model input: provider history is keyed by runId and deleted by runner finally/releaseRun. New direct prompts create new runs. Durable transcript recovery alone does not give the model previous conversation turns.
4. Provider readiness incorrectly gates explicit API fallback: controller.ts #canSubmitRequest and application.ts canSubmitPrompt require ready ChatGPT state for GMs. Ambient/explicit fallback backend availability cannot satisfy that frontend gate.
5. Normal inference depends on custom OAuth dynamic_agent_client + chatgpt.tokens.use.direct authorization and a custom models response shape. Tests mock these exchanges; no live provider completion is evidenced. This is a fragile assumption to replace with officially supported server API credentials unless architecture validation establishes supported existing auth.
6. Existing docs/live-validation.md verifies discovery/opening/disconnected UI only. It explicitly records no authenticated direct-prompt completion or live OpenAI success.

## Preserve / replace / remove

Preserve foundry-local-api module, StreamableFoundryLocalApiMcpClient authenticated Streamable HTTP adapter, trusted tool catalog, world gateway, visibility policy, operational storage, broker/session authentication and useful tests. General MCP redesign is unnecessary.

Replace the active panel/manual trigger path with genuine ChatKit frontend + supported custom backend; expose one shared app-trigger method and bind both entry points to the same persisted owner-scoped ChatKit thread. Retain existing auth via server verification and reject players for the initial GM-only path if safe context cannot be independently projected. GM-first avoids disclosing resolver secrets to players; do not trust browser claims.

Remove or deactivate obsolete panel composer/transcript/OAuth/model selector wiring only after supported replacement is integrated and references checked. Old automatic adapters must not remain a competing model entry point or accidental request loop.

## Authentication and MCP extension point

Existing Foundry session auth is useful: websocket-gateway.ts receives broker-signed assertion, issues short-lived opaque browser-memory session credentials, and revalidates durable proofs per command. worldId/userId/lane/isGm are server-authenticated. A backend ChatKit route can reuse enrollment/session validation (server must verify credential, origin and same world, never trust isGM supplied by browser). MCP credentials remain backend-only. Future tools can adapt existing catalog/client behind ChatKit server callbacks; milestone need not activate any consequential tools.

## Baseline verification

2026-09-30, target package:

- npm run typecheck: PASS (all 3 workspaces).
- npm test: PASS. Bootstrap 7, shared 9, server 97, frontend 18 = 131 tests. Deterministic/mock tests; no real ChatKit or OpenAI response verified.
- Source tracing reproduces missing streaming/continuity/readiness behavior above. No credentials were printed or inference requested.
- Listener query for ports 30000/3939/3940 returned no listeners through available PowerShell query; actual runtime availability remains for QA to establish. No runtime restart/change performed.

Remaining blockers: actual ChatKit runtime/provider credentials and Foundry UI must be verified by independent QA; installed packages/build success alone are not live proof.
