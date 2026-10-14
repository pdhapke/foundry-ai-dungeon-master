# Prompt1 independent Phase1 prerequisite gate

2026-10-03. Read-only source/evidence inspection and offline fixtures only; no inference, runtime restart, client reload, enrollment renewal, or world mutation.

PASS: Node auth/enrollment/session suites 24/24; Python latency and privacy suites 20/20 (counts include imported completion fixtures). Commands: `node --import tsx --test src/auth/chatgpt-plan-auth.test.ts src/auth/foundry-session.test.ts src/auth/enrollment.test.ts` from server; `.venv/Scripts/python.exe -m unittest test_latency_instrumentation test_prompt4_privacy_independent` from chatkit-server. These tests use mocks, not provider requests.

Credential resolution uses encrypted per-world GM OAuth sessions, required plan scope, actual expiry, native refresh with 60-second safety margin, and provider GET model discovery. Refresh and discovery already coalesce. Browser enrollment/session proofs and MCP current-GM/world authorization are separate dependencies. Historical browser rejection says Connect as Foundry GM and is not evidence that provider credentials expired. Five-minute bounded model-discovery reuse is safe only with owner/token-generation keys and independent access-token expiry handling; server revocation may remain unknown until a provider response. Local sign-out, authorization invalidation, token rotation and unavailable discovery must clear readiness. Warm preparation cannot authorize execution.

Python scope UUID source repair is present and durable trace tests pass. Independent console observation found caller `elapsedMs` can override scoped monotonic elapsed, causing decreases within one scope; worker notified for repair. Explicit duration fields and durable projected traces remain separately valid. This is a pending Phase1/4 observability gate.

Current source, disk configuration, loaded server health and browser acknowledgment remain separate evidence domains. Root reports read-only loaded AI/MCP health startup identities matching prior resume hashes and maxModelTurns15. Validator has not claimed a new loaded build, browser UI acceptance, or positive player readiness. Prior acceptance applies only to the deterministic localized sentence "A section of corridor floor is visible here." Only GM currently connected; player reconnect and exact opt-in are required for positive player acceptance. Unsupported NPC notice, trap outcomes and broad narration secrecy remain open.

No AGENTS.md found in root or inspected module/server/module/chatkit directories; root .agents absent. Unrelated dirty work retained.

Phase1 timing correction independently passed `chatkit-server/.venv/Scripts/python.exe docs/prompt1-independent-timing-test.py` (1 test): caller elapsed cannot override scope elapsed; console same-scope monotonic origins preserved.
