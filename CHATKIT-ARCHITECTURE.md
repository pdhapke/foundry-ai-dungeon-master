# ChatKit architecture validation — 2026-09-30

## Decision

Use the official ChatKit web component inside Foundry, existing authenticated Node gateway, and a loopback Python ChatKit sidecar. The official custom backend SDK is Python (`openai-chatkit`); the installed Node `openai` SDK is an API client, not a ChatKit server. Keep existing MCP services and enrollment. The first milestone is GM-only; reject player sessions before model/context work.

The custom server owns durable ChatKit threads and items. Scope each conversation to authenticated world ID and GM user ID. A frontend pointer selects the active thread on reopen; it confers no ownership. Both typed messages and imperative actions use that thread. No hosted workflow/session exchange is needed for this custom server architecture.

## Source evidence

- [ChatKit](https://developers.openai.com/api/docs/guides/chatkit): Python custom server path; official CDN web component. Hosted Agent Builder examples are unsuitable for new work.
- [Custom ChatKit integration](https://developers.openai.com/api/docs/guides/custom-chatkit): `ChatKitServer.respond`, `server.process(body, context)`, `StreamingResult`, SSE `text/event-stream`, durable `Store`, server-only metadata and request context.
- [ChatKit actions](https://developers.openai.com/api/docs/guides/chatkit-actions): imperative `sendAction({type,payload})`; server `action(thread, action, sender, context)` streams thread events; action payloads are untrusted.
- [Deprecations](https://developers.openai.com/api/docs/deprecations): Agent Builder shuts down November 30, 2026; ChatKit remains available. Assistants API retired August 26, 2026.
- [Migration guidance](https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder): move workflows into application Agents SDK code.
- [Sign in with ChatGPT inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): authorized OAuth tokens can power plan inference directly; a separate API key is not required for this route. Set `store=False`, stream, supply history, and omit unsupported fields.

Official frontend runtime script: `https://cdn.platform.openai.com/deployments/chatkit/chatkit.js`. Use `<openai-chatkit>` directly; React bindings add no value for the existing vanilla TypeScript Foundry module. Verify exact `setOptions` API against installed JS types before implementation because prose options tables can lag SDK schemas.

Installed SDK validation supersedes stale prose examples: `@openai/chatkit` exposes `sendCustomAction`, not `sendAction`; custom options are `api: {url, fetch, domainKey}`. A domain key registered for the Foundry origin is required. Python `ThreadCustomActionParams` requires an existing thread ID; native `threads.create` always supplies a user message and runs inference. Therefore authenticated `/chatkit/thread` creates an empty `ThreadMetadata` through the official Store, then the client calls `setThreadId` before its first programmatic action.

## Shared contract recommendation

- Node `POST /chatkit` receives native ChatKit request bodies and preserves SDK JSON/SSE responses. Custom frontend fetch supplies current enrollment credential, client ID and module version in headers; no API token reaches the browser.
- Node authenticates enrollment, revalidates broker GM identity, then sends server-only trusted principal and approved context to loopback Python. Do not trust user/world/role claims in ChatKit payloads. Sidecar rejects direct unauthenticated access.
- Callable Foundry interface accepts `{prompt, context?, requestId?}`. It opens/selects the private active thread then invokes installed SDK `sendCustomAction({type:'foundry.context-response',payload:{requestId,prompt,context}})`.
- Context is small explicit game observations: scene name, selected visible/authorized token names, combat round/turn. No raw journal content, hidden notes or unchecked tool output. Treat all strings as untrusted observations in model input.
- One active response per conversation; overlap rejected visibly. Deduplicate bounded request IDs; do not auto-retry model requests. Closing aborts fetch and removes component/listeners; cancellation must stop underlying model generation.
- Python persistent Store checks ownership on every thread/item operation. Attachments and tool execution remain disabled for this milestone. Future tools register through one backend agent factory/adapter; existing MCP behavior remains separate.
- Sidecar binds loopback, starts with configured Python interpreter and explicit module path. Node owns its lifecycle/health and forwards client disconnect cancellation. Credentials remain in server environment or authenticated server-to-server context.

## Local observations and prerequisites

- Installed Node `openai`: 6.49.0; MCP SDK: 1.31.0. No `@openai/chatkit` package installed at investigation time.
- Python 3.13.1 exists; `openai-chatkit` and `openai-agents` are not installed at investigation time.
- Implementation dependency owner subsequently installed Python ChatKit 1.6.5, Agents 0.22.3, FastAPI 0.142.2, Uvicorn 0.54.0. Runtime signatures checked from installed code. Current application client types are installed by dependency owner; lockfile is authoritative.
- Existing auth manager discovers models from `https://api.openai.com/v1/models` and returns server-side authorization. Reuse only successfully authorized API credentials; subscription possession alone proves no API access. A server API key is an alternative, not new OAuth infrastructure.
- No secrets were read. No live model/Foundry claims established by this investigation. Package registry query stalled under current network restrictions; installation must be verified by the dependency owner.
- Repository layout instructions read from `REPOSITORY.md`; no applicable `AGENTS.md` found by repository search.

## Verification

Read current official pages above; inspected package manifests and installed package metadata; checked Python version and package presence; inspected enrollment authentication signature and auth-manager API endpoint constants. These are read-only architecture checks, not runtime acceptance tests. Final implementation contract and commands are maintained in `CHATKIT-LEDGER.md` and implementation configuration.

Backend tests: `node --import tsx --test server/src/chatkit/gateway.test.ts` (4 pass, mocked sidecar). In `chatkit-server`, `.venv/Scripts/python.exe -m unittest test_app -v` (7 pass; real ChatKit protocol/store with mocked inference, ownership/persistence, overlap/deduplication, cancellation/guard release). Server typecheck and owned TypeScript ESLint passed. No real OpenAI response established by these checks.

Plan route correction: Python suite now has 8 passing tests, including serialized SDK HTTP capture proving current bearer/model, `store:false`, `stream:true`, history and instructions, and omitted unsupported fields. Existing OAuth registration follows official scopes, stable host, PKCE S256, nonce and loopback callback. Corrected returning callbacks to use the pending registered client ID when `client_id` is omitted and reject changed IDs. Focused authorization tests (15) and HTTP tests (3) pass; server typecheck and scoped lint pass. User consent and real plan inference remain unverified live.

Live diagnosis: official CDN sends `chatkit-frame-instance-id` with native POST requests. Initial gateway CORS allowed application authentication headers but omitted this frame header; browser only issued OPTIONS, never POST, and no thread was created. Added the observed header to the explicit origin-scoped allowlist and a preflight regression test. No wildcard origins/headers or credential-policy widening. Native MCP request timeout/cancellation and sidecar header timeout prevent validation/proxy hangs. Safe `/health` aggregate stages contain no identities, credentials or game content.
