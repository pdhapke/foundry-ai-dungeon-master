import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { AiDmMigrationError } from "./errors.js";

export interface StorageMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

function migration(version: number, name: string, sql: string): StorageMigration {
  const checksum = createHash("sha256").update(`${version}\n${name}\n${sql}`).digest("hex");
  return { version, name, sql, checksum };
}

export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [
  migration(
    1,
    "initial-operational-store",
    `
CREATE TABLE normalized_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  world_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  authenticated_client_id TEXT NOT NULL,
  authenticated_user_id TEXT NOT NULL,
  deduplication_key TEXT NOT NULL,
  source_correlation_id TEXT NOT NULL,
  source_state_revision TEXT,
  cause_event_id TEXT,
  presentation TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE(world_id, deduplication_key)
);
CREATE INDEX normalized_events_world_sequence ON normalized_events(world_id, sequence);

CREATE TABLE runtime_projections (
  projection_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES normalized_events(event_id),
  revision TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

CREATE TABLE ai_dm_threads (
  thread_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  revision TEXT NOT NULL,
  next_message_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_message_sequence > 0),
  thread_json TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ai_dm_threads_owner ON ai_dm_threads(world_id, owner_user_id, status);
CREATE UNIQUE INDEX ai_dm_threads_one_active_owner
  ON ai_dm_threads(world_id, owner_user_id) WHERE status='active';

CREATE TABLE ai_dm_runs (
  run_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES normalized_events(event_id),
  thread_id TEXT NOT NULL REFERENCES ai_dm_threads(thread_id),
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  status TEXT NOT NULL,
  status_revision INTEGER NOT NULL CHECK(status_revision >= 0),
  principal_user_id TEXT NOT NULL,
  provider_response_id TEXT,
  provider_response_run_binding TEXT,
  cancel_requested_at TEXT,
  failure_code TEXT,
  run_json TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_id, attempt),
  CHECK(provider_response_id IS NULL OR provider_response_run_binding = run_id)
);
CREATE INDEX ai_dm_runs_thread ON ai_dm_runs(thread_id, created_at);

CREATE TABLE ai_dm_run_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  run_sequence INTEGER NOT NULL CHECK(run_sequence > 0),
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  UNIQUE(run_id, run_sequence)
);

CREATE TABLE ai_dm_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES ai_dm_threads(thread_id),
  thread_sequence INTEGER NOT NULL CHECK(thread_sequence > 0),
  run_id TEXT REFERENCES ai_dm_runs(run_id),
  event_id TEXT NOT NULL REFERENCES normalized_events(event_id),
  kind TEXT NOT NULL,
  delivery_class TEXT NOT NULL,
  created_at TEXT NOT NULL,
  message_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  UNIQUE(thread_id, thread_sequence)
);

CREATE TABLE context_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  completed_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

CREATE TABLE continuation_capsules (
  capsule_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  thread_id TEXT NOT NULL REFERENCES ai_dm_threads(thread_id),
  expires_at TEXT NOT NULL,
  capsule_json TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

CREATE TABLE tool_searches (
  search_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  catalog_revision TEXT NOT NULL,
  policy_view_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  search_json TEXT NOT NULL,
  record_hash TEXT NOT NULL
);

CREATE TABLE loaded_tool_definitions (
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  tool_id TEXT NOT NULL,
  tool_revision TEXT NOT NULL,
  search_id TEXT NOT NULL REFERENCES tool_searches(search_id),
  loaded_at TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  PRIMARY KEY(run_id, tool_id, tool_revision)
);

CREATE TABLE tool_executions (
  execution_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  tool_id TEXT NOT NULL,
  effect TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed','recovery-required')),
  arguments_json TEXT NOT NULL,
  result_json TEXT,
  safe_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE action_proposals (
  proposal_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  cause_event_id TEXT NOT NULL REFERENCES normalized_events(event_id),
  proposal_revision TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE approvals (
  decision_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES action_proposals(proposal_id),
  decider_user_id TEXT NOT NULL,
  proposal_revision TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','refuse')),
  decided_at TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  UNIQUE(proposal_id, decider_user_id)
);

CREATE TABLE commit_receipts (
  receipt_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES action_proposals(proposal_id),
  operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('verified','failed','recovery-required')),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(proposal_id, operation_id)
);

CREATE TABLE recipient_streams (
  world_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence > 0),
  PRIMARY KEY(world_id, recipient_user_id)
);

CREATE TABLE delivery_outbox (
  delivery_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  recipient_sequence INTEGER NOT NULL CHECK(recipient_sequence > 0),
  thread_id TEXT REFERENCES ai_dm_threads(thread_id),
  run_id TEXT REFERENCES ai_dm_runs(run_id),
  status TEXT NOT NULL CHECK(status IN ('pending','inflight','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  delivered_at TEXT,
  safe_error_code TEXT,
  delivery_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(world_id, recipient_user_id, recipient_sequence)
);
CREATE INDEX delivery_outbox_ready ON delivery_outbox(status, available_at, lease_until);

CREATE TABLE synchronization_results (
  operation_id TEXT PRIMARY KEY,
  proposal_id TEXT REFERENCES action_proposals(proposal_id),
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE synchronization_result_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES synchronization_results(operation_id),
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE synchronization_failures (
  failure_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_dm_runs(run_id),
  proposal_id TEXT REFERENCES action_proposals(proposal_id),
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts > 0),
  safe_error_code TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX synchronization_failures_open ON synchronization_failures(status, updated_at);

CREATE TABLE recovery_markers (
  marker_id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(subject_kind, subject_id, code)
);
`,
  ),
  migration(
    2,
    "durable-client-enrollment",
    `
CREATE TABLE ai_dm_enrollments (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  expected_client_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  record_json TEXT NOT NULL
) STRICT;
CREATE INDEX ai_dm_enrollments_expiry ON ai_dm_enrollments(expires_at);

CREATE TABLE ai_dm_sessions (
  credential_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  module_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  record_json TEXT NOT NULL
) STRICT;
CREATE INDEX ai_dm_sessions_client ON ai_dm_sessions(client_id, expires_at);
`,
  ),
  migration(
    3,
    "foundry-authenticated-local-sessions",
    `
ALTER TABLE ai_dm_sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_dm_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_dm_sessions ADD COLUMN revoked_reason TEXT;

UPDATE ai_dm_sessions
SET revoked_at = COALESCE(revoked_at, '1970-01-01T00:00:00.000Z'),
    revoked_reason = COALESCE(revoked_reason, 'legacy-auth-version')
WHERE auth_version < 2;

CREATE INDEX ai_dm_sessions_identity
ON ai_dm_sessions(world_id, user_id, client_id, expires_at);
`,
  ),
];

export function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
}

export function hasMigrationTable(database: DatabaseSync): boolean {
  const row = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get() as { present?: number } | undefined;
  return row?.present === 1;
}

export function validateAppliedMigrations(
  database: DatabaseSync,
  migrations: readonly StorageMigration[] = STORAGE_MIGRATIONS,
): number {
  if (!hasMigrationTable(database)) return 0;
  const rows = database
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; checksum: string }>;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const expected = migrations[index];
    if (!expected || row.version !== expected.version) {
      throw new AiDmMigrationError("Operational database contains an unknown migration.", {
        version: row.version,
      });
    }
    if (row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new AiDmMigrationError("Operational database migration checksum drift detected.", {
        version: row.version,
      });
    }
  }
  return rows.at(-1)?.version ?? 0;
}

export function applyMigrations(
  database: DatabaseSync,
  appliedVersion: number,
  appliedAt: string,
  migrations: readonly StorageMigration[] = STORAGE_MIGRATIONS,
): void {
  ensureMigrationTable(database);
  for (const item of migrations) {
    if (item.version <= appliedVersion) continue;
    if (item.version !== appliedVersion + 1) {
      throw new AiDmMigrationError("Operational database migrations are not contiguous.", {
        expected: appliedVersion + 1,
        actual: item.version,
      });
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(item.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(item.version, item.name, item.checksum, appliedAt);
      database.exec("COMMIT");
      appliedVersion = item.version;
    } catch (error) {
      database.exec("ROLLBACK");
      throw new AiDmMigrationError("Operational database migration failed.", {
        version: item.version,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
