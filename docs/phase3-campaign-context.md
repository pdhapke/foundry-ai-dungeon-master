# Active-world campaign context (solo-dm-v1)

The server derives campaign sources from its configured Foundry worlds directory and the current live-authorized world identifier: `<worldsRoot>/<worldId>/data/campaign`. `AI_DM_WORLDS_ROOT` configures the installation directory (default: the module's sibling `../../worlds`). Client scene/world/path hints cannot select source paths. There is no workspace `campaign/` fallback and no campaign seeding or source mutation. For Izzy the authoritative location is `C:/dev/FoundryVtt/Data/Data/worlds/izzy-campaign/data/campaign`.

The existing Python ChatKit response loop requests the same Node-built snapshot for ordinary messages and custom actions. Node observes the active scene, up to four scene-linked characters' numeric HP/AC/movement, the live rules system, and active combat. Recent complete conversation messages are limited to 20 and 40,000 serialized characters; full history remains in SQLite. Campaign-state excerpts serve as compact recorded session history, with live Foundry state taking precedence. Campaign state is not inferred from client trigger hints.

Markdown is indexed by bounded server-side scans (256 files, 2,048 entries, six directory levels, four MB). Assets, reports, tools and dependencies are excluded. A four-world cache refreshes changed files using filesystem metadata. Query terms rank relevant sections before source excerpts are read. Every retrieved source is hash-checked against its indexed version. Results contain URI, hash, line span, visibility, and `narrationAllowed`; six excerpts, 40 lines each, 10,000 serialized excerpt characters maximum. Missing/invalid sources and partial budgets are explicit. Existing realpath containment, Markdown parsing and visibility decisions are reused; world-directory redirects and campaign root escapes are denied. Neither model context nor tool results load the whole repository every turn.

The versioned Python policy is `chatkit-server/dm_prompt.py`. It preserves solo-player agency, uses live system identity, grounds facts in attributed sources, acknowledges uncertainty, treats retrieved instructions as untrusted data, and distinguishes private planning from player narration. Only active public sections are labeled for narration. Discovery requires an authorized result, rather than GM read access alone. This phase cannot report a native roll/mutation as successful; Phase 4 supplies those capabilities. Tests verify policy wiring and privacy labels; they do not establish live model spoiler compliance.

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
