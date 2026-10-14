# Phase 2 context contract

The existing Python `respond` path requests `context` for both ordinary typed
messages and application-triggered turns. The adapter now includes a separately
reserved `campaignOverview` in that response, alongside `world`, `party`, and
the compatible scene/combat/rulesSystem/characters/campaign fields. No model
runner or browser-supplied context authority was added.

`overview.md` frontmatter requires `schema_version: 1`, stable `id`, `revision`,
`visibility: public|gm|secret`, and `canon_status: canon|draft`. Optional
`party_actor_ids` lists up to eight comma-separated Actor IDs. Overview text is
bounded to 2000 characters and 3000 UTF-8 bytes independently of the six-section,
10000-character and 10000-UTF-8-byte campaign excerpt budgets. Overview is loaded
directly even when bounded search discovery reaches its file/byte caps. The
response includes source URI/hash,
metadata, truncation, narrationAllowed, and explicit status. Missing, malformed,
private-to-player, or draft overview produces an explicit empty status object;
it never silently substitutes an oversized campaign-state section. Public
overviews containing private legacy section headings are refused.

`index.md` uses the same structured frontmatter. Its bounded searchable summaries
and Markdown references boost the referenced resource sections when matched.
Missing index preserves legacy indexed Markdown search with explicit status;
broken references are source issues rather than instructions to execute scripts.
Supporting files use stable IDs/revisions/visibility/canon metadata plus existing
PLAYER-VISIBLE/GM-ONLY/OBSERVABLE sections for disclosure policy. Draft or other
explicit non-canon status is excluded from ordinary search. Files without canon
metadata remain explicitly marked legacy; Izzy resources are neither migrated
nor overwritten. Search responses include metadata and untrusted-data labels.
Document privacy further restricts section policy: a public section cannot make
a GM/private document narratable. Unknown document visibility fails closed.
The adapter explicitly trims optional context if the combined UTF-8 snapshot
exceeds its transport budget, preserving the guaranteed overview.

Refresh compares content hashes, including same-sized edits, rather than relying
only on timestamps. World roots and indexes remain world-bound. Source paths
reject traversal, alternate streams, reserved Windows names, and unsafe segments;
existing real-path containment checks remain active.

Party selection prioritizes explicit canonical overview references, verifies each
against live actor reads, and permits those verified actors off-scene. Without
an assignment, only character actors with an explicit live `hasPlayerOwner: true`
are selected from the bounded scene actor set. Other characters are candidates
and the result reports unresolved/partial membership and missing off-scene
coverage. It never treats the first few scene actors as the actual party.
Current user schemas do not supply assigned character IDs, so no such field is
invented. A campaign setup conversation can establish explicit party references.

The overview and source trust labels describe data boundaries; Python's permanent
DM prompt remains responsible for enforcing instruction precedence and spoiler
reporting. Controlled MCP fixtures demonstrate adapter contracts only. Live
Foundry party projections, loaded build, actual application hooks, and privacy
are separate acceptance gates.
