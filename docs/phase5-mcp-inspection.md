# Phase5 MCP read-only inspection

Inventory phase5-start-mcp-inventory.txt captures significant dirty/untracked prior work. Root REPOSITORY.md reread; no resets, production edits, lifecycle, inference or player fixture mutations.

Current observation (phase5-current-readiness.json): exactly one opted-in GM bridge, dnd5e6.0.3; requested historical player4Nv47EuKFy06C6eO and owned fixturetoken4Jgz4kpyTaMpkdHn returned explicit NOT_CONNECTED. No connected player readiness or rendered perception can be inferred. Historical attack-vision reports demonstrate basic nonGM door/movement/light/fog rendering but structured perception blocked; those are saved reports, not current live acceptance. Phase4 embedded mechanics subsequently passed but does not prove perception.

Existing source already routes only explicitly opted-in player lane, exact user/client selection, no GM fallback. Native scene-render isolates one owned token using installed Foundry14 prepared detection modes, redacts hidden identity/secret doors/barrier coordinates/exit destinations, bounds regions/placeables/queries, records fog and native environment evidence and hashes scene/fog/token persistence before/after. Missing APIs return incomplete/unsupported; no perception inference required. Prior reports include mocked selected-source isolation tests; basic lighting is not proof every detection mode works.

Concrete gaps to review before edits:
- visibility wrapper removes capturedAt; no observation/client/actor/consent/freshness contract or explicit stale status.
- native requirePerspective checks exact user and token ownership but lacks explicit nonGM/consent assertion and final authority/context revalidation; server routes player-only today.
- unchanged persistence hashes alone do not prove perception update is settled or reconnect/scene/owner unchanged.
- input query points carry XY only. Installed App/client/canvas/groups/visibility.mjs917 defaults missing elevation to queried targetToken movementOrigin, otherwise canvas.level.elevation.base. Existing freepoint queries therefore may use a different elevation than selected character. Regions later force selectedtoken elevation regardless of query intent.
- spatial visibility is not movement/path legality. Existing native collision helper and explicit walk/teleport policy should remain separate; avoid projecting a visible-wall attribution as a verified legal route.
- installed visibility API runs normal modes against selected source and special modes for Tokens; unknown/unsupported modes must stay explicit, and exact installed API checks plus actual player rendering are needed.

Proposed narrow shared contract: additive versioned observation identifies exact nonGM/user/client/actor/token/scene, current explicit consent, capturedAt, request-local observation ID, before/after state revision and ready/stale/unavailable classification. Complete claims only after final scope/ownership/consent/readiness validation; clear visibility/region/barrier/coverage/query claims for stale/unavailable. Keep native API unavailable explicit and retain existing redaction. Add optional explicit query elevation with selectedtoken default; do not invent cross-elevation path rules. AI worker will project only validated bounded fields and prevent hidden GM information entering player narration.

Needed scoped production files after contract agreement: shared/src/scene-render.ts, module/src/commands/scene-render.ts, server/src/endpoints/scene-render.ts, server/src/endpoints/requirement-output-schemas.ts; focused tests with independent validator. No queue/combat/frontend feature changes. Player enrollment/consent and expanded fixture changes require root-owned supported manual setup and approved live plan first.
