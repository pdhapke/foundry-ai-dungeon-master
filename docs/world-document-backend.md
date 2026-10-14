# Known-family world document backend

The additive foundry_get_world_document and foundry_apply_world_document bridge
endpoints cover 21 explicitly reviewed active-world document families: Actors,
Items, JournalEntries/pages, Scenes and their Token/Wall/Drawing/Note/Light/Sound/
Template/Region children, Combats, Playlists, RollTables, Cards, Folders, Actor
items/effects and Item effects. These use native Document collections/classes;
there is no arbitrary collection name, compendium, filesystem root or script
executor. Both the bridge user and requesting user must be active live GMs in
the exact active world. World document operations do not require current scene.

Read input: worldId, requestingUserId, family, operation get|list, optional
targetId/parentId, offset (0..100000) and limit (1..20). Get returns source|null
and revision|null; list returns id/name/type/revision summaries and nextOffset.
Canonical SHA-256 recursively sorts object keys in JavaScript lexical order and
omits _stats at every depth. Source hashing/reads are limited to 24k UTF-8 bytes;
larger documents fail explicitly rather than silently truncate revisions.

Apply input: the same scope, operation create|update|delete, targetId (required by
backend; the trusted Node adapter chooses a valid 16-character Foundry ID for
create), typed parentId, data for create/update, expectedRevision SHA-256|null,
server-generated correlationId and durable idempotencyKey. Delete and ownership/
permissions or bulk embedded-child changes require reviewedDestructive supplied
by the trusted Node exact human review path. That Boolean is not exposed as a
model approval mechanism; raw backend MCP access remains quarantined. Executable
content is always rejected even with review, including script/command/macro
keys, DAE/ItemMacro flags, effect change keys macro.execute/macro.itemMacro and
HTML event handlers/JavaScript URLs. A future code executor needs separate policy.

Preflight hashes the complete source, then recaptures canonical current source
after hashing and repeats live authorization immediately before native dispatch.
This optimistic check is not atomic Foundry core CAS. Returned updates must match
the requested leaf fields; delete must read back absence. Receipt includes source,
revision, world/family/operation/target/parent, correlationId, idempotencyKey and
verified:true. Exceptions after mutation are uncertain. The Node caller owns the
durable execution claim and must never blindly retry this non-idempotent endpoint.

Executor options carry foundry-local-api.world-document/apply provenance and the
same correlationId plus authorized GM movement marker. These are provenance,
not permission. Echo-sensitive families require a validated origin bridge before
admission: the initial Region origin cache recognizes session-action operations,
so generic token/scene/Region mutations remain quarantined until their marker is
explicitly supported and independently validated.

The separate session-action condition path now uses CONFIG ActiveEffect factory
and native create/delete with actual provenance options rather than
toggleStatusEffect (which drops options in installed Foundry). Live authorization
and condition state are rechecked after the asynchronous factory. Combat-next
pre/post state includes authoritative turnCount, but only round/turn are written
to the Combat document.

Evidence: seven focused controlled-Foundry/schema tests pass; local-api module and
server typechecks and focused lint pass. Shared build completed. These tests do
not prove live native Document behavior, loaded identity, privacy, or actual
embedded ChatKit calls. No running modules were reloaded or world fixtures
created. Existing unrelated local-api changes were preserved; integration adds
only registrations alongside them.
