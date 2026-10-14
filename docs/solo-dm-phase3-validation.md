# Independent Phase 3 validation — October 1, 2026

Offline authoring gate: **PASS after repair**. Live authoring/privacy/model behavior remain separate unverified gates; production persistence remains disabled.

## Durable decision repair

Initial independent review reproduced a race where an overlapping rejection overwrote completed approval state and receipt despite canon already being committed. The implementation owner replaced unconditional state writes with exact-prior-JSON plus batch-digest compare-and-swap transitions. Creation, draft checkpoints, rejection/cancellation, stale marking, dispatch claims, final checkpoints and restart reconciliation now return the winning persisted entry when a competing transition wins. Active filesystem writer locks do not authorize stealing its SQL state.

The original independent regression is unchanged and now passes: real child-process approval finishes between the parent's pending read and negative-decision write; parent returns completed winning state and preserved receipt. The new opposite-direction implementation regression also passes: a child winning rejection prevents parent approval dispatch. Both use real temporary files and SQLite; deterministic scheduling hooks expose the process interleavings rather than mocking persistence.

## Independent checks

Reran authoring, independent authoring race, storage, independent storage crash/recovery and turns suites: **23 passed, zero failed**. Workspace typecheck: **passed**. Full Python unittest suite: **20 passed**. Earlier Phase 3 review additionally reran independent context regressions, all passing. The retained script covers setup → separate stored draft → exact browser approval → canonical receipt → later preparation → refreshed retrieval; no model approval operation; duplicate/conflicting IDs/digests, stale/expired proposals, restart receipt reconciliation, rollback after partial writes, scope isolation, revocation, cancellation and world serialization.

Reviewed durable fsynced read-back receipt markers and rollback journals. Interrupted context is withheld. Production constructs campaignActions without a private-storage verification callback: proposal persistence returns storage_unavailable before storing sensitive proposal payload/drafts. Model/browser fields cannot enable that boundary. World roots come from trusted configuration and run identities bind world/user/thread. Python wrappers map snake_case to exact adapter camelCase, expose only read/propose/status, retain pending/uncertain outcomes and byte bounds, and preserve the existing single model loop.

## Limits

This is offline filesystem/SQLite/adapter evidence, not actual conversational-model or live Foundry behavior. Auth callbacks and MCP projections are controlled fixtures. Synchronous batches use the documented ten-second world/identity/cancellation lease; network revocation cannot interrupt the event loop mid-synchronous operation and is checked at boundaries. Surviving locks require operator-confirmed process death before removal. Power-loss durability, direct-file privacy, loaded Foundry behavior and actual adversarial model resistance remain separate gates.

Existing Izzy resources and dirty local-api work were untouched. Changed paths owned by validator: this report and server/src/chatkit/campaign-actions.validation.test.ts only. Implementation repair was performed by its assigned owner. No deployment/config, credential, fixture-world, reload or model-use changes. Durable-race blocker: resolved. Dependent offline work may proceed while preserving live/privacy gates.
