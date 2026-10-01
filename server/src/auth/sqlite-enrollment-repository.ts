import type { DatabaseSync } from "node:sqlite";

import type { AiDmEnrollmentRepository, EnrollmentRecord, SessionRecord } from "./enrollment.js";

function enrollment(row: { record_json: string } | undefined): EnrollmentRecord | null {
  return row ? (JSON.parse(row.record_json) as EnrollmentRecord) : null;
}

function session(row: { record_json: string } | undefined): SessionRecord | null {
  return row ? (JSON.parse(row.record_json) as SessionRecord) : null;
}

/** Durable repository containing only credential hashes, never raw codes or sessions. */
export class SqliteAiDmEnrollmentRepository implements AiDmEnrollmentRepository {
  constructor(private readonly database: DatabaseSync) {}

  saveEnrollment(record: EnrollmentRecord): void {
    this.database
      .prepare(
        `INSERT INTO ai_dm_enrollments(
           code_hash,user_id,world_id,lane,expected_client_id,expires_at,consumed_at,record_json
         ) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.codeHash,
        record.userId,
        record.worldId,
        record.lane,
        record.expectedClientId,
        record.expiresAt,
        record.consumedAt,
        JSON.stringify(record),
      );
  }

  findEnrollment(codeHash: string): EnrollmentRecord | null {
    return enrollment(
      this.database
        .prepare("SELECT record_json FROM ai_dm_enrollments WHERE code_hash=?")
        .get(codeHash) as { record_json: string } | undefined,
    );
  }

  consumeEnrollment(codeHash: string, consumedAt: string): boolean {
    const current = this.findEnrollment(codeHash);
    if (!current || current.consumedAt) return false;
    const next = { ...current, consumedAt };
    return (
      this.database
        .prepare(
          `UPDATE ai_dm_enrollments SET consumed_at=?, record_json=?
           WHERE code_hash=? AND consumed_at IS NULL`,
        )
        .run(consumedAt, JSON.stringify(next), codeHash).changes === 1
    );
  }

  saveSession(record: SessionRecord): void {
    this.database
      .prepare(
        `INSERT INTO ai_dm_sessions(
           credential_hash,client_id,user_id,world_id,module_version,expires_at,revoked_at,record_json,
           auth_version,generation
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.credentialHash,
        record.clientId,
        record.identity.userId,
        record.identity.worldId,
        record.moduleVersion,
        record.expiresAt,
        record.revokedAt,
        JSON.stringify(record),
        record.authVersion ?? 1,
        record.generation ?? 1,
      );
  }

  findSession(credentialHash: string): SessionRecord | null {
    return session(
      this.database
        .prepare("SELECT record_json FROM ai_dm_sessions WHERE credential_hash=?")
        .get(credentialHash) as { record_json: string } | undefined,
    );
  }

  revokeSession(credentialHash: string, revokedAt: string): void {
    const current = this.findSession(credentialHash);
    if (!current || current.revokedAt) return;
    const next = { ...current, revokedAt };
    this.database
      .prepare("UPDATE ai_dm_sessions SET revoked_at=?, record_json=? WHERE credential_hash=?")
      .run(revokedAt, JSON.stringify(next), credentialHash);
  }
}
