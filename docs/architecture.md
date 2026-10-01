# AI Dungeon Master architecture

## Product and process boundary

`foundry-ai-dungeon-master` is a separate Foundry v14 module with a local server process. The
Foundry browser never receives an OpenAI credential and never calls OpenAI. The existing
`foundry-local-api` module/server remains an independently versioned, authenticated capability
provider. This project consumes it through narrow adapters and does not weaken or duplicate its
bridge authentication, effective-user routing, enrollment, redaction, revision, or idempotency
contracts.

The filesystem campaign is canonical for narrative state. Foundry is canonical for live tabletop
documents, presentation, and returned document IDs. SQLite stores reconstructible operational
state only.

## One event-driven pipeline

Every direct prompt, approved retry, future transcript, or eligible Foundry hook becomes one
durable normalized event. In order, the server persists the event, derives an authoritative runtime
projection, builds a small root context manifest, starts a fresh bounded model run, permits bounded
recursive context and trusted tool discovery, resolves reads/simulations, validates proposed
mutations, obtains required approval, commits idempotently with revision checks and read-back,
delivers recipient-specific messages, and stores a compact continuation capsule.

Provider response IDs may continue tool calls inside one run only. A later event receives stable
instructions, its own event/projection/root, and an eligible validated capsule; it never inherits the
prior provider response chain.

## Trust boundaries

- The authenticated server connection determines user, lane, world, GM authority, ownership, and
  permitted audience. Client context is a hint only.
- Context nodes carry revision, authority, visibility, provenance, relationships, and dependency
  revisions. Derived summaries are disposable and stale when any dependency revision changes.
- Context access enforces recipient visibility before returning data. Until mechanical
  declassification is integrated, player runs conservatively cannot read GM/secret nodes.
- Resolution and presentation are separate context views inside one run. The resolver may consume
  GM-only nodes and emit typed, policy-reviewed resolution facts. The player-facing presenter sees
  only recipient-visible nodes plus facts explicitly declassified for that audience.
- Tool discovery searches only exact-name allowlisted metadata over a live provider snapshot.
  Unknown provider tools are quarantined. A selected schema receives a digest-bound, expiring,
  run-scoped grant; discovery is never authorization.
- Safe reads and simulations may run during resolution. Consequential operations become typed
  proposals. Policy decides auto-commit, player confirmation, GM approval, or refusal.
- Commits require a selected trusted tool revision, bounded arguments, expected state revisions,
  expiry, call limits, idempotency keys, and immediate read-back or an explicit recovery result.
- Rendering treats model output as text. The server creates recipient-specific payloads; clients do
  not receive secrets and then hide them.

## Foundry-authenticated identity

The new module owns a separate user-scoped WebSocket protocol; it does not reuse or inspect another
module's browser credentials. On connection, the local AI server asks the authenticated Foundry
server to attest the current browser session. A successful exchange creates a short-lived local
session bound to the exact world, user, lane, browser session, client, and module version. The raw
session credential remains only in browser memory, is revalidated before commands, and is renewed
automatically. There is no manual enrollment or copied bearer credential in the normal flow. Claimed
user IDs, roles, audience, selections, and ownership are always re-derived or checked server-side.
Disconnection, expiry, replay, binding mismatch, protocol mismatch, or unavailable verification
fails closed.

No OpenAI key or `foundry-local-api` server credential enters module code, Foundry settings, or
browser storage. `FOUNDRY_LOCAL_API_KEY` is internal server-to-server configuration only. Foundry
startup generates `AI_DM_FOUNDRY_BROKER_SECRET` for that process tree; it is neither operator
configuration nor persistent storage. Other server-to-server credentials remain in the local process
environment.

## Operational database

The server uses Node 24's built-in SQLite support with foreign keys, WAL, full synchronous writes,
bounded busy timeout, transactional migrations, checksums, and startup integrity checks. It stores
events, projections, threads, messages, runs, run events, context receipts, capsules, tool searches,
loaded definitions, executions, proposals, approvals, commit receipts, delivery outbox rows, and
synchronization failures. Corruption, unknown migrations, and uncertain consequential writes fail
closed. Backups are checkpoint-consistent and never replace campaign or Foundry truth.

## Automatic trigger gate

Direct text prompts are the first end-to-end path. Combat, doors/Regions, Item use, and rolls follow
incrementally. Movement-driven runs remain disabled until durable movement generation/cursor/schema
health and authorship are proven. Gaps, restarts, unattributed movement, or schema mismatch fail
closed without inventing consequences.
