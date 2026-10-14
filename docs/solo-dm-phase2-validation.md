# Independent Phase 2 validation — October 1, 2026

Offline context gate: **PASS after repair**. No live Foundry, model prompt-injection, or deployment-privacy acceptance claim.

## Repair evidence

Initial independent validation found three defects: overview excluded at the general search file cap; document-private metadata overridden by PLAYER-VISIBLE section flags; and Unicode excerpts exceeding the adapter UTF-8 allocation. The implementation owner repaired each; the three independent regressions were unchanged and all now pass.

- Overview directly loads the fixed overview.md path through the bounded world-scoped source repository, independently of index walk limits. Parser/source hash agreement detects a change during its read. Metadata identifiers/revisions, visibility/canon status and party references are bounded. Output retains its separate text byte allocation and truncation flags.
- Document visibility now restricts access and narration in addition to section policy. Unknown visibility is excluded; gm/secret content cannot be narrated publicly even if its section is PLAYER-VISIBLE. Existing unannotated legacy disclosure behavior remains explicit.
- Search excerpts enforce both 10000 JSON characters and 10000 UTF-8 bytes. Adapter fitContext sheds optional snapshot/campaign details and records truncation while retaining the reserved overview. The ordinary active-scene branch retains the final 24000-byte check; no-scene context also uses fitContext.

## Independent checks

Targeted context/source/read-adapter suite: **19 passed, zero failed**, including three independent real-temporary-filesystem regressions. Workspace typecheck: **passed**. Existing Python tests were run during initial review: **14 passed**; no Python code changed in these repairs. Source hashing refreshes same-sized edits, world switching does not reuse other-world resources, and junction escapes are rejected. Legacy campaign files remain readable without migration or overwrite. Explicit canonical party references support off-scene reads; unspecified membership reports unresolved/partial coverage instead of selecting arbitrary first actors.

Python respond uses the same authenticated context adapter for ordinary typed messages and application actions. No second model loop was introduced. Missing/malformed/draft overview is explicitly unavailable. Bounded search can omit oversized sections and reports partial context; this is an acknowledged retrieval limitation, not a claim that all source material is loaded.

## Limits and remaining gates

MCP scene/actor/world fixtures and authorization callbacks prove adapter contracts, not actual live Foundry party projection/ownership or hook behavior. Untrusted-data labels and the permanent DM prompt establish policy boundaries; no billable adversarial model run was authorized. Live prompt-injection resistance remains a separate acceptance gate. HTTP campaign privacy remains FAIL/BLOCKED from independent earlier review and live authoring remains disabled.

No Izzy resources, services, fixtures, reloads, credentials or deployment configuration changed. Changed paths owned by validator: this report and server/src/context/world-campaign.validation.test.ts only. Contract changes by validator: none. Context repair blocker: resolved. Next step: dependent offline phases may proceed; preserve separate live gates.
