# Deterministic source inventory and record preparation

The protected campaign root is the only inventory boundary. Run from `server`:

```
node --import tsx ../scripts/preparation-source-drafts.mjs --world=<selected-world> --candidate=<new-review-id> --inventory-approved-campaign
```

This is an explicit approved-root inventory, not repository discovery. Existing private-root configuration and source containment contracts apply. Markdown is supported; other formats are listed without execution, and derived/runtime directories and symbolic redirects are excluded. Source failures fail closed. Overlarge whole sections are separately listed for narrower review. Repeat runs require a new review ID: exclusive writes preserve prior drafts and manual edits.

`prepareSourceRecords` verifies world/URI/hash identity and deduplication, imposes 512-source/8 MB aggregate bounds, and copies complete sections with original full-file SHA-256 and exact line spans. H3 subsections remain with their H2 parent; fenced headings are data. Each document becomes a stable URI-derived private draft record. Directory-based kind classification is mechanical, not entity inference. Explicit valid authored frontmatter IDs and simple scalar/list aliases become lookup aliases with metadata line provenance; ambiguous duplicate aliases are withheld and recorded as contradictions. No name is inferred from a heading. Unsupported YAML expressions remain unresolved; frontmatter is never permission authority.

Explicit Markdown links become `source-reference` relationships only when they resolve to another selected source URI in the same protected world. External, unselected and escaping references remain unknown. This relation asserts a source link, not ownership, knowledge, alliance or other narrative meaning. `resolveSelectedSourceReferences` can re-resolve the graph after corpus composition; individual review packets leave references to other packets unresolved. Embedded instructions remain quoted source data.

`sourceRecordDraftPackets` produces a small source-backed overview from selected top-level premise/setup/current-state sections, a record directory, and detailed on-demand source records. All remain GM-only, unconfirmed, and ungenerated. All overview references join the input manifest. The overview has a 3,500-byte copied-content ceiling; the inventory is never injected into permanent context.

Each review packet retains a 28-record limit and adaptive 110,000-byte serialized ceiling. The production referenced-v2 corpus store now supports up to 256 records through explicit candidate composition; the packet limit is not the store limit. Overlarge single records require narrower review, never truncation. A packet alone must not be presented as activating the full corpus. Corpus composition preserves active records and must re-resolve selected source references before validation. No staging, canonical publication, inference, Foundry mutation, scene import or runtime restart occurs in this CLI.

The production `PreparationSourceInventory` helper offers authenticated GM-only metadata pages of at most 32 entries and selected reads of at most 32 sources. It caches bounded inventory snapshots; explicit refresh invalidates old cursors. Source content is loaded only on selected reads and revalidated through the existing source repository. Caller authorization is checked before and after reads; player/cross-world callers receive no counts, paths or source content. Derived sources and symbolic redirects are not admitted.

Offline validation: `node --import tsx --test src/preparation/source-inventory.test.ts src/preparation/preparation-records.test.ts` passed 17 tests, including full section/qualification preservation, embedded instructions, drift, cross-world and duplicate identity, authored alias provenance and ambiguity, selected-source link resolution and recomposition, adaptive packet byte/count bounds, deterministic ordering, private defaults, round-trip records, small overview provenance, paginated snapshot caching, stale cursors, and authorization revocation. TypeScript no-emit validation passed.

Actual source names, content, counts, exclusions and review files remain in the private `preparation-drafts/<world>/<review-id>` directory, not in statically served module documentation. Human review still resolves source conflicts, missing facts and disclosure before canonical publication; Foundry remains authoritative for current mechanics.
