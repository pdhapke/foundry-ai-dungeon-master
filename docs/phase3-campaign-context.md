# Active-world campaign context (current solo-DM implementation)

The server derives campaign sources from its configured Foundry worlds directory and the current live-authorized world identifier: `<worldsRoot>/<worldId>/data/campaign`. `AI_DM_WORLDS_ROOT` configures the installation directory (default: the module's sibling `../../worlds`). Client scene/world/path hints cannot select source roots. There is no workspace fallback. Typed campaign proposals and reviewed revision-checked batch authoring are now implemented, but production persistence remains disabled until privacy protection and supported verification wiring are approved and verified. Existing Izzy resources were not migrated or overwritten. Current contracts: [overview/retrieval](solo-dm-phase2.md), [authoring](solo-dm-phase3.md), [discovery](solo-dm-phase4.md).

The existing Python ChatKit response loop requests the same Node-built snapshot for ordinary messages and custom actions. A separately loaded bounded overview survives search-index caps. Explicit canonical party references are verified by live Actor reads, including off-scene actors; fallback selects explicitly player-owned characters and reports missing/ambiguous membership. The first few scene actors are not treated as the party. Rules system and active combat remain authoritative. Recent complete conversation messages are limited to 20 and 40000 serialized characters; full history remains in SQLite. Campaign-state excerpts remain recorded history. Browser observations are data, not live-state authority.

Markdown is indexed by bounded server scans (256 files, 2048 entries, six directory levels, four MB). Assets, reports, tools and dependencies are excluded. Content hashes refresh changed sources, including same-size edits. Canonical index summaries boost linked resources; legacy indexed search remains available with explicit status. Results contain URI/hash/span/revision/canon status/visibility/narrationAllowed: six excerpts, forty lines each, 10000 serialized characters and 10000 UTF-8 bytes. Document privacy further constrains section disclosure; drafts are excluded. Essential overview has a separate 3000-UTF-8-byte/2000-character budget. Transport trimming explicitly removes optional context while preserving it. Containment, unsafe-path and source-hash checks remain active; missing/stale/truncated context is reported.

The permanent Python policy is `solo-dm-v3` in dm_prompt.py. Setup/preparation/play share that assignment and the existing single model loop. It preserves agency, grounds rules/facts in evidence and keeps source instructions untrusted. Draft-to-canon changes require exact authenticated human review and verified persistence receipts. The reviewed game-action MVP includes durable native dice and approved GM-private session notes; pending or uncertain results cannot support completed narration. Tests establish policy wiring and contract labels, not live model compliance.

## Reviewed campaign utilities

All four scripts in Izzy's world `campaign/tools` were inspected. They were copied from an earlier workspace arrangement and hard-code obsolete workspace-derived paths:

- `reconcile-foundry-ids.mjs`: reads the MCP endpoint configuration, performs remote Foundry reads, and rewrites Markdown IDs. Excluded: network and source mutation, stale path assumptions.
- `sync-foundry-journals.mjs`: reads credentials and campaign Markdown and creates/updates Foundry journals/folders. Excluded: administrative mutation and hard-coded IDs.
- `upload-izzy-token.mjs`: creates directories and copies a fixed token asset. Excluded: filesystem mutation and hard-coded world/paths.
- `validate-campaign.mjs`: recursively reads sources/assets, checks links/frontmatter and writes console diagnostics. Its general filesystem traversal and stale path assumptions are unsuitable for direct model execution.

A reviewed replacement `campaign_validate_sources()` has typed empty input and read-only effects: it runs the bounded existing Markdown parser and reports indexed-document count, invalid source paths and scan truncation. It does not execute scripts, shell commands, external requests, writes, or arbitrary paths. This is source-parser validation, not complete asset/link/Foundry-ID validation. `campaign_search(query: str)` accepts a query of at most 256 characters. Both share the authenticated, expiring, cancellable Phase 2 adapter and twelve-call run budget. They use only the active world's roots.

## Verification

Run from module root: `npm run typecheck`, `npm run build`, `npm test`, and `chatkit-server/.venv/Scripts/python.exe -m unittest discover -s chatkit-server -p test_app.py`.

Controlled fixtures exercise relevant retrieval, source attribution, missing/stale files, world switching, unsafe IDs, real filesystem junction escape, private injection sections, budgets, utilities, and ordinary/action snapshot parity. MCP/model transport are explicitly mocked. No billable model test is performed. Live model spoiler-safe narration and live full-scene acceptance remain later acceptance prerequisites.
