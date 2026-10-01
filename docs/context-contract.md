# Recursive context contract

Context is a revisioned graph, not a recursively expanded prompt. Each node records authority, read scope, disclosure scope, activation, source URI/hash/span, dependencies, and edges. Authoritative campaign and Foundry facts do not depend on generated summaries.

Stable context operations are `context_get_root`, `context_read`, `context_expand`, `context_search`, `context_get_changes`, and `context_get_source`. Reads, nodes, depth, characters, and estimated tokens are cumulatively bounded. `NEXT-LOAD` edges require explicit activation. Realpath containment, Markdown-only loading, source spans, and file-size limits fail closed.

Resolver and presenter views are separate. In the current player path the resolver is intentionally denied GM/secret nodes; GM runs may read them. This conservative gate remains until a mechanically enforced declassification stage exists. Every completed run persists an exact node/revision receipt.
