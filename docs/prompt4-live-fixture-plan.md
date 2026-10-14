# Prompt 4 prepared model-free fixture plan

Prepared only; no live requests or mutations were executed by this worker. Syntax check `node --check scripts/prompt4-live-fixtures.mjs` passes. This helper uses the existing authenticated MCP client and existing supported document validation, native perception, viewport, and revision-checked fog APIs. It never calls a model, starts/restarts a service, changes settings/consent, or retries uncertain mutations.

## Prerequisites and separate gates

Root must first verify manually restarted Node/Python server identity, then targeted native client reload identity. Prepared native marker is recorded in `prompt4-native-audit.md`; root must compare it with current receiver evidence, separately from historical server startup native hashes. Require exactly one opted-in GM and intended opted-in non-GM Izzy user `edtBL96Yu3058QAT`. Capture selects the actual fresh clientId/connectedAt and subsequent execution fences that connection; reconnect requires stopping and recapturing, not substituting a GM. Automatic gameplay events must already be false; helper refuses to toggle them. Missing identity, client, consent, ownership, schema API, native validation, warning-free candidate, or readback means stop.

The fixture reproduces the already calibrated Phase5 geometry (1200x800, 100px/5ft grid, ground/basicSight/global light, x600 barrier) in a new disposable scene. It is not an existing campaign scene; root should retain the existing calibrated campaign scene for the later approved inference proposal if appropriate. Only the two captured clients' views change. World active scene, pause, combat, original actors/scenes, automatic events, and original fog remain untouched. It uses exact recorded actual IDs and unique UUID-bearing scene/actor names as test ownership fencing, omitting optional namespace flags so generic schema discovery remains warning-free.

## Explicit run order

From the AI module directory, root runs one mode at a time:

```text
node scripts/prompt4-live-fixtures.mjs capture
node scripts/prompt4-live-fixtures.mjs setup
node scripts/prompt4-live-fixtures.mjs view
node scripts/prompt4-live-fixtures.mjs read
node scripts/prompt4-live-fixtures.mjs secret
node scripts/prompt4-live-fixtures.mjs read
node scripts/prompt4-live-fixtures.mjs second
node scripts/prompt4-live-fixtures.mjs read
node scripts/prompt4-live-fixtures.mjs restore
node scripts/prompt4-live-fixtures.mjs verify
```

`capture` is read-only. Saves exact world, client identities/consent capability, intended GM/player viewports, other opted-in client views, original target scene documents and their referenced actors, original target users' fog, active scene, pause, combat documents, and automatic event setting. No credential fields are printed or saved by this helper. Capture refuses to overwrite unfinished evidence. Native build verification is a root prerequisite, not inferred from capture.

`setup` validates every exact candidate before creation. Creates a new intended-player OWNER NPC, OBSERVER scene, closed regular door barrier, owned linked primary source at (200,350), ordinary target beyond barrier at (850,350), hidden non-owned target near primary at (300,550). Predetermined IDs are saved before calls; actual created IDs and complete receipts are persisted immediately. Every mutation has pending/confirmed/uncertain state; uncertainty stops further work and needs independent reconciliation. Partial setup can be restored using exact owned scene/actor IDs. No fixture is activated globally.

`view` changes only exact GM/player viewports to the fixture via targeted supported API, then reads both receiver identities/views. Root observes the actual player browser separately; backend receipts do not prove rendering.

`secret` reads the actual existing wall coordinates and validates `{c,door:2,ds:0}` before updating that exact fixture wall. Supported secret-door enum must pass repaired native/portable validator. Expect visible wall obstruction may be evidenced; the secret door ID/label/type/destination must remain redacted. Do not infer a secret door or environmental cause merely from occlusion.

`second` validates a linked second basicSight token owned through the same exact intended-player actor at (850,350). Each source is queried separately with the intended player identity. Primary query beyond closed barrier remains occluded; second query near itself should be visible. The player's rendered canvas may show the union of its permitted sources, while the selected-token result remains source-specific. This tests attribution/isolation under actual player ownership without importing GM sources. It does not establish every vision mode or a token-membership elevation rule.

`read` saves native MCP reports with explicit scope annotation. It performs before/after world/player/consent fencing. These are **not authenticated AI adapter traces** and **not browser observations**. Root runs the separately prepared adapter probe for the same exact scene/player/token and records browser rendering separately. Query points are near-primary (250,400,Z0) and beyond-door (900,400,Z0). Visible hidden target must remain omitted; sightings do not imply threat discovery, creature awareness, trap triggering, or movement legality.

## Restoration and independent verification

`restore` requires same world, exact GM, automatic events still false and no uncertain operation. It restores original GM/player views and requires viewport readback within 1px / scale0.001 before deletion. If player is disconnected or consent revoked, root reconnects/re-enrolls the exact intended user as needed; no identity substitution or silent forced setting change.

While the fixture scene still exists, read each fixture user's fog; remove existing records with `foundry_update_scene_fog`, exact fresh revision and saved unique idempotency key. Re-read fog and record `exists:false` **before** deleting the scene. A conflict, recreated record or incomplete result blocks scene deletion. Never claim post-deletion fog absence using a getter requiring an existing scene.

Delete only exact recorded UUID-named scene/actor and verify absence from their collections. Original fog is compared, not overwritten. Compare complete original scenes and referenced actors, all captured viewports, active scene, pause, combat, automatic event setting and consent with originals. A changed original remains a blocker needing inspection, not automatic overwrite. `verify` independently repeats readbacks using the saved ledger after restoration, asserting world identity first. Root should additionally independently inspect fog-before-delete receipts and collections rather than relying only on the helper's summary.

Fog may flush asynchronously after a scene view changes; if fixture fog reappears during cleanup, stop and inspect while the scene exists. If consent/connection changes intentionally during adapter negative tests, restoration reports may remain blocked until the expected client returns. Unrelated non-opted-in clients have no supported targeted observation; their views are never changed by this helper and root should preserve their browser state manually.

No paid narration prompts or allowance are included. Later embedded-chat inference requires the exact Phase5 proposal, explicit approval, fixed maximum calls/retries/model/provider, stop conditions, and manual player acceptance.

## Installed native scene-view correction (live setup follow-up)

Root reports fixture scene5ZMNJbyeEtvowSHG and actor/token/wall creation confirmed, but helper view call rejected before pan because `foundry_apply_client_viewport` does not switch scenes. Treat the earlier view-mode description/run step above as superseded: root must first use exact targeted browser-native **View scene** navigation on GM and player separately, then verify exact readiness scene IDs before any bounded pan. Before restore mode, similarly return each browser to its captured original scene through native View; only then restore its captured viewport. Do not activate the fixture globally.

Installed Foundry14.368 `App/common/documents/scene.mjs` lines70-73 defines `navigation` BooleanField(initial:true), `navOrder` numeric, `navName` string; no navDisplay field/enum exists. `client/applications/ui/scene-navigation.mjs` prepares visibility as active OR isView OR (navigation AND scene.visible). `client/documents/abstract/client-document.mjs` visible is native LIMITED permission; intended player's existing OBSERVER2 fixture grant satisfies that. GM Hidden eye-slash icon merely indicates ownership.default0 and inactive; it does not prohibit viewing. Existing fixture navigation:true/OBS2 requires no mutation. Expand inactive scene navigation or use the Scene sidebar's exact View action; its supported click handler calls `game.scenes.get(data-scene-id).view()` locally. Never invent navDisplay or broaden public ownership merely to remove the Hidden icon.

`local-api/module/src/commands/client-readiness.ts` `applyClientViewport` first calls replayOrThrow, then checks canvas scene exact identity. Mismatch throws INVALID_PAYLOAD at sceneId with message requested Scene not active on this client, before `begin` and `canvas.animatePan`. Thus a fresh correlation failing that precondition cannot have panned or recorded a new pending viewport command. Existing acknowledgement/pending correlation replay is a separate earlier path and must be excluded. Root reconciles the helper's conservative uncertain row only after exact error evidence, original readiness/viewport comparison and source-order review. Preserve the error/correlation evidence; do not blindly retry. This worker made no live calls or mutations during this inspection.
