import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AiDmStorageIntegrityError } from "./errors.js";
import { openStorageDatabase } from "./database.js";
import { applyMigrations, STORAGE_MIGRATIONS } from "./migrations.js";

function fixturePath(name = "operations.sqlite"): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "ai-dm-storage-"));
  return { directory, path: join(directory, name) };
}

void describe("AI Dungeon Master operational database", () => {
  void it("creates the schema, persists it across restart, and applies hardened pragmas", async () => {
    const fixture = fixturePath();
    const first = await openStorageDatabase({ path: fixture.path });
    const migration = first.connection
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get() as { version: number; name: string };
    assert.equal(migration.version, 3);
    assert.equal(migration.name, "foundry-authenticated-local-sessions");
    assert.equal(
      (first.connection.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys,
      1,
    );
    first.close();

    const restarted = await openStorageDatabase({ path: fixture.path });
    assert.equal(
      (
        restarted.connection.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
          count: number;
        }
      ).count,
      3,
    );
    assert.equal(restarted.migrationBackupPath, null);
    restarted.close();
  });

  void it("preserves but revokes legacy enrollment sessions during the v3 upgrade", async () => {
    const fixture = fixturePath();
    const legacy = new DatabaseSync(fixture.path);
    applyMigrations(legacy, 0, "2026-01-01T00:00:00.000Z", STORAGE_MIGRATIONS.slice(0, 2));
    legacy
      .prepare(
        `INSERT INTO ai_dm_sessions(
          credential_hash, client_id, user_id, world_id, module_version,
          expires_at, revoked_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        "legacy-hash",
        "legacy-client",
        "legacy-user",
        "legacy-world",
        "0.1.0",
        "2099-01-01T00:00:00.000Z",
        JSON.stringify({ credentialHash: "legacy-hash" }),
      );
    legacy.close();

    const upgraded = await openStorageDatabase({ path: fixture.path });
    const row = upgraded.connection
      .prepare(
        "SELECT auth_version, generation, revoked_at, revoked_reason FROM ai_dm_sessions WHERE credential_hash=?",
      )
      .get("legacy-hash") as {
      auth_version: number;
      generation: number;
      revoked_at: string | null;
      revoked_reason: string | null;
    };
    assert.equal(row.auth_version, 1);
    assert.equal(row.generation, 1);
    assert.equal(row.revoked_at, "1970-01-01T00:00:00.000Z");
    assert.equal(row.revoked_reason, "legacy-auth-version");
    upgraded.close();

    const restarted = await openStorageDatabase({ path: fixture.path });
    assert.equal(
      (
        restarted.connection
          .prepare("SELECT revoked_reason FROM ai_dm_sessions WHERE credential_hash=?")
          .get("legacy-hash") as { revoked_reason: string }
      ).revoked_reason,
      "legacy-auth-version",
    );
    restarted.close();
  });

  void it("uses the online backup API before migrating a pre-existing database", async () => {
    const fixture = fixturePath();
    const legacy = new DatabaseSync(fixture.path);
    legacy.exec(
      "CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker VALUES ('kept')",
    );
    legacy.close();

    const opened = await openStorageDatabase({
      path: fixture.path,
      backupDirectory: join(fixture.directory, "backups"),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    assert.ok(opened.migrationBackupPath);
    assert.equal(existsSync(opened.migrationBackupPath), true);
    const backup = new DatabaseSync(opened.migrationBackupPath);
    assert.equal(
      (backup.prepare("SELECT value FROM legacy_marker").get() as { value: string }).value,
      "kept",
    );
    backup.close();
    opened.close();
  });

  void it("fails closed on migration checksum drift", async () => {
    const fixture = fixturePath();
    const first = await openStorageDatabase({ path: fixture.path });
    first.close();
    const tamper = new DatabaseSync(fixture.path);
    tamper.exec("UPDATE schema_migrations SET checksum='tampered'");
    tamper.close();

    await assert.rejects(
      openStorageDatabase({ path: fixture.path }),
      (error: unknown) =>
        error instanceof AiDmStorageIntegrityError && error.code === "STORAGE_INTEGRITY_FAILURE",
    );
  });

  void it("preserves and refuses a corrupt database", async () => {
    const fixture = fixturePath();
    writeFileSync(fixture.path, "not a sqlite database", "utf8");
    await assert.rejects(
      openStorageDatabase({ path: fixture.path }),
      (error: unknown) => error instanceof AiDmStorageIntegrityError,
    );
    assert.equal(existsSync(fixture.path), true);
  });
});
