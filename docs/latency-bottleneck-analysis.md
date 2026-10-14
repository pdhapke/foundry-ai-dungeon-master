# Read-only analysis of measured Node preparation bottlenecks

2026-10-02. No source changes, inference, settings changes, services or runtime mutations. Phase 3 remains paused.

Evidence: AI `.runtime/ai-dungeon-master/latency-traces.jsonl`, originating Node processRunId `6da17e5e-5ee6-4c37-8bad-919f88c5ec58`. Differences below use the same Node monotonic clock. Python durations are separately measured spans, never subtracted from Node clocks.

| Correlation | Credential resolution interval | Context catalog refresh | Included MCP catalog-list span | Refresh remainder |
| --- | ---: | ---: | ---: | ---: |
| 479005cd-d3d7-4e91-b848-1e8c07abbac5 | 1140.39 ms | 355.34 ms | 328.67 ms | 26.67 ms |
| 48fe577f-6a51-4647-963e-73da94e01e01 | 570.32 ms | 678.06 ms | 634.24 ms | 43.82 ms |

Credential interval is `credentials-resolved.monotonicMs - queued-authorization-finished.monotonicMs`. It is outside the model request. The first Python context-prepared duration was 751.01 ms, and model-response duration 3848.63 ms. The second context duration was 922.41 ms and model-response duration 5766.39 ms. Catalog refresh is contained in preparation; it must not be added to the full context duration.

Each of these commands has exactly one Node mcp:catalog-list and one context:catalog-refresh span. The observed initial-context path does not duplicate catalog refresh within a command. Later catalog discovery/execute paths do refresh separately, but neither measured routine command shows those discovery calls. There is no evidence here of a duplicate routine listing to remove.

## Credential resolver

Gateway index.ts resolveAuthorization calls ChatGptPlanAuth.resolveModel for the existing ChatGPT authorization. resolveModel validates provider state and resolves the current token before refreshing model selection. Existing controls:

- Access token is reused only while more than 60 seconds from expiry; renewal is singleflight per world.
- Model discovery already has a 60-second cache bound to world, authorization owner and access-token hash; maximum 32 worlds. Token rotation, expiry, owner change and invalidation force new discovery.
- Concurrent discovery is singleflight by world/token hash.
- Model selection persistence occurs only when the selected model changes.
- Discovery uses the provider models endpoint; it is not a generation request. Authorization failures invalidate state rather than enabling fallback.

The two measured embedded requests began 105.94 seconds apart, beyond the model cache TTL. Consequently, calling the second sample warm for authorization is unjustified. A refresh through a separate status request could have warmed the cache in between; the traces do not expose that cache state. No credentials or stored token material were inspected.

The 1140/570ms intervals currently cannot distinguish OAuth renewal, provider model discovery, model-cache validation or rare selected-model persistence. The smallest next diagnostic change is separate safe spans for token-cache/renewal, models-cache hit/miss/discovery and selection persistence. Do not blindly extend TTL or replace current authorization with a permanent grant. A benchmark with requests less than 60 seconds apart, using the existing approved request budget, would determine whether the current cache already removes this delay. No extra inference should be spent solely to classify the bottleneck.

If resolver and queued GM authorization are independent after initial authentication, running them concurrently while requiring both to succeed before dispatch would preserve the final authority boundary. Its maximum opportunity in the first sample is only the measured queued authorization span, approximately 42ms; it cannot eliminate the 1140ms resolver cost. This is a secondary candidate, not a claimed improvement.

## Catalog resolver

TrustedToolCatalog.refresh always fetches provider.snapshot, clones/sorts definitions, hashes schemas, constructs descriptors and hashes the catalog revision. FoundryLocalApiProviderAdapter.snapshot fetches tools/list every time and computes a local canonical digest of the advertised definitions. StreamableFoundryLocalApiMcpClient has no tools/list_changed revision cache. The MCP server supports integration-driven list_changed notifications, but the AI client currently registers no corresponding invalidation/reconnect strategy.

The catalog-list span includes authenticated request/response plus SDK parsing; it is not a pure network-only measurement. It accounts for most of refresh in both samples. The residual approximately 27/44ms includes provider mapping/hash and catalog reconstruction. Removing catalog construction cannot remove the observed 329/634ms list span.

Smallest safe optimization candidate: retain fresh authenticated tools/list each turn; reuse the built immutable catalog when the locally canonical provider-definition digest and provider identity/version plus policy metadata are unchanged. Avoid trusting an arbitrary advertised revision without proving its digest semantics. Never reuse grants/authority or live world state. Independent validation must cover changed schema with unchanged advertised revision, provider/system changes, policy changes, revoked permissions, malformed definitions, reconnects and world isolation. Expected opportunity is limited to the measured rebuild remainder; no latency guarantee or distribution is inferred from two samples.

Removing repeated catalog-list transport is a larger change requiring explicit invalidation, validated notifications, new-session/reconnect invalidation and missed-notification handling. A TTL by itself does not establish schema freshness. That is not the smallest safe initial change.

## Decision

Do not change the model or queue for this investigation. First measure credential suboperations and actual within-TTL behavior, then consider digest-validated catalog reconstruction reuse. Model time remains the largest measured component, while preparation has independently identified provider metadata costs. Source candidates alone do not establish live improvement. Rebenchmark only within separately approved inference bounds and compare equivalent fixtures/context.

## Subsequent prerequisite blocker: Foundry browser credential expiry

Read-only SQLite projection of noncredential fields at 2026-10-02T18:39:30.858Z found the latest session unrevoked, authVersion 2, generation 1, expired at 18:37:22.890Z. All five recent projected sessions were expired. No credential hashes, raw credentials or secrets were printed. Browser chatKitHeaders checks local expiration before starting a latency probe and throws the generic Connect-as-GM message; therefore an expired attempt has no trace by design. Exact rejection timestamp was not captured, so expiry is supported by current state and source, not proven by a timestamped failed request.

Root authorized the narrow prerequisite repair after this finding. transport.ts now renews 30 seconds before the existing expiry through a new client WebSocket and the existing live Foundry identity challenge/assertion. The current server ignores a new identify message on an authenticated socket, so sending it on the old socket would not renew. This is a browser transport reconnect, not a server/service restart. Client/browser IDs remain immutable; user/world/lane checks remain live. Old socket events and delayed Foundry acknowledgement callbacks are fenced.

Renewal connected handling performs no automatic model discovery, policy write, history request or action replay. Expired ChatKit header access requests renewal and throws an explicit no-action-sent message requiring manual resubmission after Connected. Renewal failure identifies the credential failure. TTL is unchanged, and no submitted action is retried.

Focused transport tests: 10 PASS, including pre-expiry fresh challenge, binding preservation, no command replay, late-socket fencing, expiry submit refusal, failed renewal and disconnect cancellation. Module typecheck/build passed. docs/latency-renewal-tests.log contains results. Independent validator gate and loaded frontend refresh remain required; this restores a test prerequisite, not a measured speed improvement.
