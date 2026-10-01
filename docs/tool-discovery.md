# Tool discovery protocol

Runs begin with only context operations, `tool_search`, `tool_load`, `state_propose`, and `run_complete`. There is no interaction classifier.

The catalog refreshes from authenticated MCP `tools/list`, applies an exact-name reviewed metadata overlay, quarantines unknown tools, and computes stable provider/catalog/policy-view/schema revisions. Search combines exact names, field-weighted BM25, and one-hop relationships. Permission and availability filters run before results are returned.

`tool_load` is valid only for a tool returned by the same run's search. It creates a digest-bound, expiring grant. Invocation revalidates catalog, policy, schema, arguments, effects, call budget, and—when committing—approval, expected revisions, and idempotency. Discovery never expands authority.

The initial overlay admits seven reviewed capabilities. Legacy mutations that lack both expected-revision and idempotent commit guarantees remain proposal-only or are refused by policy.
