# Prompt 1 credential preparation findings

2026-10-03. Offline implementation; no inference, model summary, embedding, provider discovery against real accounts, runtime restart, or world mutations.

## Measured path and authentication boundary

Prior observations credential-resolution 1140.4/570.3 ms cover gateway `resolveAuthorization` -> existing `ChatGptPlanAuth.resolveModel`. That path looks up encrypted per-world OAuth state, verifies direct-plan scope, uses actual `expires_in` expiry with 60-second safety margin, refreshes through the existing OAuth token endpoint only when needed, and resolves selected eligible model through GET `/v1/models`. Models discovery previously had a separate arbitrary 60-second TTL. This is neither browser enrollment nor MCP authorization. The recorded browser disconnected/rejected condition is not evidence of expired provider credentials; exact root cause remains unestablished. Current session authentication checks browser binding/expiry and current GM via authenticated MCP before preparation and each command.

## Implemented safe reuse

Authenticated POST `/chatkit/prepare` reuses the gateway/session integration and starts credential/context preparation concurrently. Concurrent callers share a bounded operation keyed by world/user/client; cancelled waiters do not cancel another command's shared work. No preparation calls the Python inference endpoint. The existing credential manager retains OAuth refresh and models-discovery singleflight. Models are reusable for at most five minutes and never beyond access-token expiry minus safety margin; provider catalog has no dependable revision feed, so five minutes is a conservative bound rather than proof of continued availability. Revocation/selection/rotation clear existing cached state; stale refresh/discovery publication cannot resurrect signed-out authorization.

Refresh now has a bounded timeout and exponential failure backoff capped at 60 seconds, with one attempt per demand and no background loop. Invalid refresh HTTP 400/401/403 fails reconnect. Commands arriving during preparation await it before existing resolution; command credentials still go only to authenticated loopback Python. Ready has a 30-second validity bound (shorter if expiry demands); it means current GM/prerequisite checks passed, not provider acceptance of the next inference. Actual authorization and live Foundry action validation remain required.

Prepared context uses the existing read-tools/campaign/cache implementation. Gateway exposes only readiness metadata, model name, and expiry; it does not publish prepared private context or credentials. Current source hashing/live authorization remain command responsibilities.

## Validation and remaining gates

Tests are offline mocks: `docs/prompt1-credential-tests.txt` includes preparation concurrency, expired browser session, role changes, bounded failed preparation and secret-safe responses, explicit >60-second cache reuse, expiry safety boundary, refresh timeout/backoff and revocation during refresh/discovery; plus existing encrypted OAuth, expiry/rotation, discovery/revocation, scope-loss and refresh singleflight suites. Gateway/authority regressions included. Combined 34 tests passed; server typecheck passed. Independent validation is owned separately.

Source/disk changes are separate from loaded runtime. No restart was performed; loaded implementation/UI acceptance requires Peter's manual stop/restart and startup artifact verification. Real sign-in, revoked-provider confirmation, browser rendering, new positive player/TV acceptance and inference latency remain untested. Prior player acceptance applies only to the recorded deterministic corridor sentence, not broad narration secrecy or encounters. Temporary loaded one-turn cap must be checked after restart; no cap configuration was changed here.
