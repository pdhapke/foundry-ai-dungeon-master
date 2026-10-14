# Authored active-world file contract

WorldFiles is an additive TypeScript service. It receives only trusted server
worldsRoot and an operational DatabaseSync. Every call takes the authenticated
GM identity supplied by the adapter and revalidates it against the live world
through authority.authorize. World ID, user, root and approval cannot originate
from a model argument. No production wiring or model wrapper was added here.

## Frozen service API

- list(identity, relativeDirectory="", after="", limit=50): at most 100 sorted
  file/folder metadata entries plus next cursor; protected entries are omitted.
- read(identity, relativePath, encoding="metadata"): bytes and SHA-256 revision;
  explicitly utf8 or base64 returns at most 12,000 raw bytes. UTF-8 is validated.
  Metadata for files over the write budget has revision:null (unavailable), never
  a fabricated content hash. Large assets can be inspected by metadata without
  loading them into model context.
- issueIntent(identity, request): server-only exact current human authorization
  callback returns an opaque object registered in a private WeakMap. Recreating
  an object with the same digest cannot authorize an effect. The returned object
  must remain server-side; no model/browser approved:true or raw grant accepted.
- apply(identity, intent): atomic revision-bound write/mkdir/delete, or explicit
  recovery. Durable receipts are scoped to world/user/requestId; identical replay
  returns the receipt, conflicting arguments reject. Pending outcomes cannot be
  redispatched and block ordinary reads/writes until reviewed recovery.

Request fields: requestId (ASCII identifier <=128), operation write|mkdir|delete|
recover, path (relative forward-slash path <=500), expectedRevision (SHA-256 or
null for missing target), and only for write encoding utf8|base64 plus content.
Default write budget is 1 MiB, configurable by trusted constructor up to 4 MiB.
Binary base64 must be canonical-shaped; output expansion is explicit. Missing
parent folders are safely created. This permits authored notes, assets and
ordinary JSON/CSS/data formats without a fixed file-extension allowlist.

authorizeWriteIntent(identity, frozenRequest, requestDigest) must verify exact
current human intent from trusted ingress, separate from retrieved content,
history, automatic events and model text. It is not a natural-language regex
ceiling; the application can collect missing details conversationally and expose
an exact human operation review. authorizeDeleteIntent is a separate callback
requiring destructive review of exact path/content revision/digest. Do not wire
either callback to unconditional allow or an assistant's claim of approval.
Delete is file-only; recursive deletion is unsupported.

All mutating calls also require assertPrivateStorage(worldId). Its absence fails
closed. Deployment verification must cover the active world files AND private
operational SQLite journals/backups, because recovery snapshots can contain
private file bytes. Current Foundry direct Data serving is not protected by
companion authentication. No environment toggle, credential, server/network
change, live fixture or public audit route was created to bypass this gate.

## Safety and recovery

Traversal, absolute paths, backslashes, Windows alternate streams/reserved names
(including superscript device aliases), control characters, dangling links,
junction escapes and cross-world intent reuse reject. Each existing ancestor is
checked with lstat/realpath. Reserved staging names are inaccessible. Node cannot
offer Windows openat-style protection against hostile local administrator races;
local administrators must not replace directories during service operations.

Foundry live databases under data (actors/cards/combats/fog/items/journal/macros/
playlists/scenes/settings/users), packs, world.json, runtime/git/dependency
folders, database files, recognizable credential material and executable host
code require supported Foundry APIs. These are explicit exceptions protecting
running state and credentials, not permission restrictions on ordinary authored
files. The DM must truthfully explain these boundaries and discover the relevant
Foundry operation instead of editing a live database or manifest directly.

A unique pending-world SQLite claim serializes cooperative writers across
processes; revisions are checked again after the final awaited authority check.
The journal stores before/after bytes and planned created folders before effects.
Writes use exclusive staging, file fsync and rename, followed by byte hash read-
back. Receipts are marked completed only after final authority/privacy checks.
Errors after effects remain unresolved, never implicitly successful or retried.

Recovery requires a fresh server-issued exact intent and current observed hash.
It accepts only journal-known before/after content, rolls back pending effects,
removes only empty service-created folders and verifies staging snapshots before
cleanup. Unknown edits or populated folders block recovery. Preserve the journal
and inspect such conflicts; never overwrite new content automatically. Filesystem
rename and SQLite completion are recoverable, not a single atomic cross-resource
transaction; host power-loss directory durability depends on the platform.

## Evidence and remaining integration

Real temporary-filesystem tests cover arbitrary authored/binary content, stale
and concurrent edits, link/junction containment, malicious Windows paths, privacy
failure, authorization revocation, interrupted completion/recovery, opaque grant
rejection and separately approved deletion. These tests do not prove live
Foundry privacy or loaded model behavior. Root/storage own authenticated wrapper,
exact review UI and production callback wiring; private writes remain disabled
until approved deployment/privacy verification. Existing world resources were
untouched.
