import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { AiDmStorageIntegrityError } from "./errors.js";
import {
  applyMigrations,
  hasMigrationTable,
  STORAGE_MIGRATIONS,
  validateAppliedMigrations,
} from "./migrations.js";

export interface OpenStorageOptions {
  path: string;
  backupDirectory?: string;
  busyTimeoutMs?: number;
  now?: () => Date;
}

export class AiDmStorageDatabase {
  constructor(
    readonly connection: DatabaseSync,
    readonly path: string,
    readonly migrationBackupPath: string | null,
  ) {}

  close(): void {
    if (this.path !== ":memory:") this.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.connection.close();
  }
}

function assertNode24(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new AiDmStorageIntegrityError("AI Dungeon Master storage requires Node.js 24 or newer.", {
      detectedVersion: process.versions.node,
    });
  }
}

function configure(database: DatabaseSync, inMemory: boolean, busyTimeoutMs: number): void {
  database.exec("PRAGMA foreign_keys=ON");
  database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
  if (!inMemory) database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA trusted_schema=OFF");
  database.exec("PRAGMA wal_autocheckpoint=1000");
}

export function checkDatabaseIntegrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  const messages = rows.flatMap((row) => Object.values(row)).map(String);
  if (messages.length !== 1 || messages[0] !== "ok") {
    throw new AiDmStorageIntegrityError("Operational database integrity check failed.", {
      messages,
    });
  }
}

function backupName(now: Date): string {
  return `${now.toISOString().replaceAll(":", "-")}-${randomUUID()}.sqlite`;
}

/** Opens, integrity-checks, backs up before migration, and migrates the operational database. */
export async function openStorageDatabase(
  options: OpenStorageOptions,
): Promise<AiDmStorageDatabase> {
  assertNode24();
  const now = options.now ?? (() => new Date());
  const inMemory = options.path === ":memory:";
  const existed = !inMemory && existsSync(options.path) && statSync(options.path).size > 0;
  if (!inMemory) mkdirSync(dirname(options.path), { recursive: true });

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(options.path, { allowExtension: false });
    configure(database, inMemory, options.busyTimeoutMs ?? 5_000);
    checkDatabaseIntegrity(database);

    const appliedVersion = validateAppliedMigrations(database);
    const latestVersion = STORAGE_MIGRATIONS.at(-1)?.version ?? 0;
    const needsMigration = appliedVersion < latestVersion || !hasMigrationTable(database);
    let migrationBackupPath: string | null = null;
    if (existed && needsMigration) {
      const backupDirectory = options.backupDirectory ?? join(dirname(options.path), "backups");
      mkdirSync(backupDirectory, { recursive: true });
      migrationBackupPath = join(backupDirectory, backupName(now()));
      await backup(database, migrationBackupPath);
      try {
        chmodSync(migrationBackupPath, 0o600);
      } catch {
        // Windows ACLs remain authoritative; chmod is best-effort portability hardening.
      }
    }

    applyMigrations(database, appliedVersion, now().toISOString());
    checkDatabaseIntegrity(database);
    if (typeof database.enableDefensive === "function") database.enableDefensive(true);
    if (!inMemory) {
      try {
        chmodSync(options.path, 0o600);
      } catch {
        // See backup chmod note above.
      }
    }
    return new AiDmStorageDatabase(database, options.path, migrationBackupPath);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original startup error.
    }
    if (error instanceof AiDmStorageIntegrityError) throw error;
    throw new AiDmStorageIntegrityError("Unable to open the operational database safely.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
