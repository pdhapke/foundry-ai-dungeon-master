# Prompt 2 independent initial audit gate

2026-10-04. Independent read-only source review and model-free fixture tests. No runtime restart, inference, campaign publication, scene mutation, or generated artifact.

## Evidence and decision

Read Prompt 1 implementation handoff, final GM verification, context admission repair, private cutover result and restarted verification. Current source contracts independently inspected: protected-campaign.ts, world-campaign.ts, campaign-storage.ts, visibility-policy.ts, and battlemap recipe.

ProtectedCampaignOptions separates server-owned private root from actual static Data root; realpath containment and redirect checks reject public storage. World IDs are bounded and resolve inside per-world private directories; pending transactions/locks withhold context. CampaignStorage reauthorizes reads/writes, fences expected revisions, journals rollback snapshots and persists idempotent receipts. Private staging must reuse these contracts and remain outside Data. Original archive and media preservation are historical runtime evidence, not independently reaccepted live by this audit.

Selected-model admission remains 24,576 conservative input units with the documented 19,154 permanent / 22,510 realistic fixture baseline. New detailed prompts, tool descriptions and resources must remain on demand and admission must be rerun after integration. Readiness must retain context admission plus current identity and permission checks. Health does not establish browser readiness.

Existing protected copy currently contains 135 Markdown, 26 JSON, 4 MJS, 3 Python and one PYC file: 168 authored files plus one compiled cache. Preparation inventory must explicitly exclude executable/cache files from narrative extraction, report supported/unsupported formats, and not count the PYC as an original. overview.md/index.md remain missing prerequisites; reviewable source-backed drafts are authorized, publication is a separate parent/manual gate.

Existing source-contract fixtures: 7/7 passed in prompt2-independent-existing-contracts.log. Coverage includes private copy byte preservation/isolation, revision storage, cancellation, recovery, overview reservation, document privacy and Unicode result bounds. These are offline fixture results.

## Required correction/coverage

WorldCampaignContext.retrieve filters unauthorized excerpts but returns all-source issue filenames and indexedDocuments metadata. Prompt 2 retrieval must filter errors/counts/index manifests as rigorously as excerpts, including relationships and continuation metadata. No new player-facing route may inherit this leak. This is a source finding, not live exploitation.

Map recipe already distinguishes grid alignment, physical scale, authorized assets, target TV identity, and separate generation approval. Existing foundry_align_scene_grid accepts size/distance/shift plus expectedModifiedTime and dryRun; it cannot independently migrate every populated scene entity. No reliable evidence in this scoped audit establishes which scene Peter considers affected. Current-map correction therefore remains blocked on reliable scene identification and visual acceptance; no scene is guessed.

Model-free regression should use a duplicate/fixture with grid landmarks near opposite edges, independently calculate spacing/origin/residual drift, reject nonuniform distortion, preserve actor links and geometry, require source/scene revision revalidation, and separately label TV profile/physical scale as unaccepted. Native inactive fixture preparation must never activate a scene or traps.

Initial gate: PASS for proceeding with private, bounded, model-free implementation against existing interfaces; player metadata leak, real scene identification, publication and live/browser acceptance remain explicit integration gates. Root and AI module .agents/AGENTS.md were absent at inspected locations; parent is responsible for any wider applicable instruction discovery. No unrelated files or memories modified.
