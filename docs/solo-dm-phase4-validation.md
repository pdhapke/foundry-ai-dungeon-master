# Independent Phase 4 validation — October 1, 2026

Offline discovery/game-control contract gate: **PASS**. Live Foundry execution/read-back and model behavior remain unverified.

## Independent evidence

Read catalog-tools.ts, read-tools.ts, trusted runtime/catalog tests, native action service/tests, Python wrappers, discovery_contract_probe.py, and Phase 4 documentation. Independently ran catalog integration + trusted catalog + native action suites: **29 passed, zero failed**. Workspace typecheck: **passed**. Full Python unittest suite: **21 passed**.

The integration suite starts an ephemeral authenticated loopback HTTP adapter and invokes actual Python function-tool wrappers in a subprocess. Those wrappers search, load a run-scoped grant, and execute through TypeScript policy and durable native actions into a controlled MCP fixture. The subprocess reported Python-to-HTTP-adapter-to-catalog-to-controlled-MCP PASS; exactly one fixture dice execution occurred. This exercises the cross-language wire chain without a model or real Foundry.

## Reviewed boundaries

Search/load/execute use existing world/user/thread-bound, expiring response capabilities and internal secret headers. Cross-world, revoked/released/cancelled boundaries deny. Tool execution accepts grantId plus read/present/propose and schema arguments; no commitAuthorization, provider URL, arbitrary execution tool name or model approval field is accepted. Unknown upstream tools are quarantined. Schema/policy/catalog drift and grant expiry deny before invocation. The new server-owned runtime callback is reached after grant, permission, schema, effect, argument and call-budget checks; default execution behavior for existing sessions remains intact.

Search is bounded to four requests and eight results, six loaded schemas, twelve calls plus total/transport bounds. Oversized schemas/results refuse rather than presenting a silently truncated usable schema. Trusted semantic dice/private-note definitions include upstream dependency schema digests. Their loaded schemas are explicit semantic facades, not falsely attributed raw MCP tools.

Read facades reuse bounded authoritative projection, check current scene/off-scene assigned actor references, filter hidden tokens and label results non-narratable/untrusted. Raw GM document bodies are not returned through discovery. Canon campaign authoring retains its separately approved Phase 3 contract.

Durable dice and private notes retain stable action IDs and scoped payload checks. Tests cover exact duplicate/concurrent replay, conflicting arguments, stale preflight, revocation, cancellation, malformed receipts, restart and uncertain outcomes. Dice completed receipts require actual evaluated results; uncertainty never rerolls blindly. Private-note discovery only preflights/persists pending proposals; a separate authenticated human decision is required for transaction mutation. Runtime executed means facade invocation, not proof of completed game mutation; pending/uncertain results remain explicit and dispatched present/propose failures are non-retryable.

## Limits

MVP actions are native dice with no chat posting, and approved private Journal creation. Door/HP/inventory/movement/combat mutations remain unavailable because generic schemas alone do not supply safe policy/idempotency guarantees. This is a documented functional limit, not a claim of unrestricted game control. Existing native-action concurrency evidence is within its single owning server process; multiple independent native-action server instances sharing one database were not accepted or proved. Catalog providers and authorization callbacks remain fixtures. No loaded Foundry build, real MCP mutation/read-back, billable model, or adversarial live model test was exercised.

HTTP campaign privacy remains FAIL/BLOCKED and production campaign persistence remains disabled. No deployment/config, credentials, live fixture world, reload or related-module edits occurred. Changed path: this report only. Contract changes by validator: none. Next step: full Phase 5 independent trigger gate and final offline checks, preserving separate live acceptance requirements.
