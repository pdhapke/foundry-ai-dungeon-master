export class AiDmStorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AiDmStorageError";
  }
}

export class AiDmStorageConflictError extends AiDmStorageError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("STORAGE_CONFLICT", message, details);
    this.name = "AiDmStorageConflictError";
  }
}

export class AiDmStorageIntegrityError extends AiDmStorageError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("STORAGE_INTEGRITY_FAILURE", message, details);
    this.name = "AiDmStorageIntegrityError";
  }
}

export class AiDmMigrationError extends AiDmStorageError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("STORAGE_MIGRATION_FAILURE", message, details);
    this.name = "AiDmMigrationError";
  }
}
