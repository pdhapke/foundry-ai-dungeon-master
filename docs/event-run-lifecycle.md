# Event and run lifecycle

1. The Foundry-authenticated WebSocket connection supplies identity; client IDs in payloads are not accepted.
2. A direct prompt or reviewed automatic hook becomes a schema-versioned normalized event with a world-scoped deduplication key and monotonic sequence.
3. The server re-reads world, user, Scene, Actor ownership, combat, and active-user facts through `foundry-local-api`. Selection values remain hints until cross-checked.
4. A fresh run is persisted without a provider response ID. The deterministic root binds the event, principal, projection, budgets, and direct context nodes.
5. The model can read context, search trusted tools, and load selected schemas. Every call remains run-scoped and budgeted.
6. Consequential operations become policy-reviewed proposals. Unsafe provider contracts are refused.
7. Recipient-specific output enters the durable outbox. Private operational receipts are sent only to the initiating identity; public recipients receive only public narration.
8. A signed continuation capsule contains a compact summary and source revisions, never a provider response ID.

Duplicate request IDs replay the existing event/run acknowledgement and never start another model run. Restart recovery marks interrupted resolution failed and marks uncertain commits for reconciliation.
