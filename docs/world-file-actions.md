# ChatKit active world file adapter

`ChatKitWorldFileActions` receives the world root, SQLite database, live GM authorization callback, and optional deployment privacy callback from trusted server configuration. Model arguments contain only relative paths. Without `assertPrivateStorage`, all writes remain disabled.

List uses bounded `after` pagination; read defaults to metadata and content reads are limited to 12 KB. Write and mkdir require current server-issued ordinary GM `worldControl` authority, a durable action ID, and expected revision. Canonical `data/campaign` mutations require campaign proposal controls and are rejected here.

Delete and recovery create durable proposals. The browser receives exact request and before data and approves the SHA-256 of stable JSON `{scope,input:request,before,selectedTarget:request.path}`. Approval is scoped to world, user, thread and action. No model approval fields are accepted. Cancellation, revocation and stale revisions leave proposals without reusable authority. Recovery also compares its reviewed interruption journal before dispatch.

Opaque WorldFiles intents exist only during execution and are checked against the exact server-authorized request. Every filesystem authorization checks cancellation and live GM state. Durable dispatch markers become uncertain after restart; replay returns the recorded state and never automatically repeats an uncertain effect. The WorldFiles layer owns containment, revisions, journaling and recovery. Adapter tests use temporary real world folders and SQLite, including interruption and restart.
