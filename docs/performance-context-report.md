# Context preparation and routine completion contract

Date: 2026-10-02. Offline implementation evidence; live acceptance pending the manual speed checkpoint.

## Inventory and ownership

Inspected root REPOSITORY.md and the AI DM package status before editing. No AGENTS.md was present at root or inside this module. Significant dirty and untracked baseline files existed, including read-tools.ts, gateway.ts, world-campaign.ts, app.py, runtime identity source and previously recorded routine-speed evidence. Those changes were preserved. HEAD was not used as the tested-build identity.

Owned edits: server/src/chatkit/read-tools.ts, gateway.ts, new routine-completion.ts and routine-completion.test.ts, server/src/build-identity.ts, this report and the focused test log. No MCP module, runtime service, browser fixture or live world edits.

## Phase 2 change

Initial context already used four parallel independent reads, one dependent active-scene read, compact projection, lazy actor/campaign detail and a source-hash-validated campaign parsing cache. These optimizations were retained.

Only initial_context now treats its five read-only calls as one bounded disclosure. Live adapter authority is checked before dispatch, between the independent and dependent read phases, and after all reads before any data is returned. Every call still validates its trusted catalog schema, availability, effect and policy. MCP authentication and the gateway checks remain intact. Mutation execution checks are unchanged. Detailed reads retain their per-call checks.

For an active scene, adapter authorization invocations fall from twelve to three per initial-context request (nine fewer). Catalog refresh remains once per request; context-data reads remain five. No mutable world, actor, system, schema or permission cache was added. Removing the refresh would require trustworthy revision/reconnect guarantees absent from the inspected path.

Existing operation traces distinguish catalog refresh, each MCP read and each authority check. New traces identify authorization-between-read-phases and serialization-and-budget-validation; existing campaign-overview-source-hash-and-parse includes cache validation. No mock measurement is represented as live latency.

The final disclosure also rechecks cancellation, run existence/expiry and the UTF-8 transport budget. Revocation during a read rejects the snapshot instead of releasing partial context.

## Phase 1 gateway contract

Authenticated loopback header x-chatkit-completion carries base64 JSON {version:1, toolName, arguments}. It is generated from one complete direct human input_text request. It never comes from user metadata, a custom action, prompt context or model output. It is eligibility evidence, not execution authority.

The exact, anchored grammar supports pause, explicit scene/door/token/actor/combat/combatant IDs, HP, conditions, initiative, native actor rolls and bounded dice formulas. Movement explicitly distinguishes walk and teleport. Commands with target labels needing retrieval, compound requests, narration, negative requests or extra text do not receive a contract and continue normally. This intentionally conservative limitation means ordinary actor-name or door-label commands do not yet qualify for the generalized shortcut.

Examples: `open door D in scene S`; `move token T in scene S to 40,60`; `set actor A hp to 12 in scene S`; `roll 2d6+3`; `advance combat C in scene S turn`. Explicit IDs still require valid current native-system state. Confirmed result validation and SDK protocol/persistence are implemented and independently validated by the Python completion worker.

New routine-completion.js is included in startup build identity; Python helper work stays in already-hashed app.py.

## Validation and remaining gate

Focused offline tests: 13 passed, 0 failed across read-tools.test.ts, context.routine-speed.validation.test.ts and routine-completion.test.ts. A further nine gateway/pause, build-identity and independent preparation tests passed. Server TypeScript typecheck and build passed. Detailed output: performance-context-tests.log and performance-context-independent-tests.log. Independent validator owns performance-independent.validation.test.ts and reported PASS for isolation, fresh per-turn reads, revocation during either read phase, release/reconnect rejection and malformed requests.

No paid inference was requested. No services were started, stopped or restarted. New server code requires the user's manual Foundry stack restart; the orchestrator supplies exact steps and verifies loaded artifacts afterward. Current on-disk builds and saved historical reports do not prove the running code matches these changes.

Live before/after preparation timings, equivalent short/detailed prompts, visible receipts and final narration remain pending user restart, live prerequisites, bounded inference approval and manual evaluation. Phase 3 queue behavior and broader combat work remain disabled until the user approves the speed checkpoint.
