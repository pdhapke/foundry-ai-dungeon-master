import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface MovementGenerationRolloverInput {
  expectedGeneration: string;
  expectedMovementSha256: string;
  idempotencyKey: string;
  confirmation: "quarantine-and-rollover";
}

export interface MovementGenerationRolloverResult {
  status: "completed";
  replayed: boolean;
  oldGeneration: string;
  newGeneration: string;
  quarantine: {
    movementFile: string;
    movementBytes: number;
    movementSha256: string;
    deliveryFile: string;
    deliveryBytes: number;
    deliverySha256: string;
    deliveryItemCount: number;
  };
  current: {
    movementSha256: string;
    deliverySha256: string;
    cursor: string;
  };
  completedAt: number;
}

interface Receipt extends Omit<MovementGenerationRolloverResult, "replayed"> {
  version: 1;
  fingerprint: string;
  consumerId: string;
}

export class MovementGenerationRolloverError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "IDEMPOTENCY_CONFLICT"
      | "HASH_MISMATCH"
      | "GENERATION_MISMATCH"
      | "STORE_NOT_RECOVERABLE"
      | "DELIVERY_STORE_MISMATCH"
      | "RECOVERY_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "MovementGenerationRolloverError";
  }
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBounded(path: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > maxBytes)
      throw new MovementGenerationRolloverError(
        "STORE_NOT_RECOVERABLE",
        `Recovery input must be a regular file no larger than ${maxBytes} bytes.`,
      );
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    const descriptor = openSync(temporary, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary path may never have existed or may already be renamed.
    }
    throw error;
  }
}

function archiveExact(path: string, bytes: Buffer): void {
  if (existsSync(path)) {
    const existing = readBounded(path, MAX_STORE_BYTES);
    if (!existing.equals(bytes))
      throw new MovementGenerationRolloverError(
        "RECOVERY_CONFLICT",
        `Existing quarantine artifact ${basename(path)} does not match the expected bytes.`,
      );
    return;
  }
  atomicWrite(path, bytes);
}

function replaceExpected(path: string, beforeHash: string, after: Buffer): void {
  const current = readBounded(path, MAX_STORE_BYTES);
  const currentHash = digest(current);
  const afterHash = digest(after);
  if (currentHash === afterHash) return;
  if (currentHash !== beforeHash)
    throw new MovementGenerationRolloverError(
      "RECOVERY_CONFLICT",
      `Current ${basename(path)} no longer matches either side of the recorded recovery boundary.`,
    );
  atomicWrite(path, after);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class MovementGenerationRolloverService {
  constructor(
    private readonly movementPath: string,
    private readonly deliveryPath: string,
    private readonly consumerId: string,
    private readonly now: () => number = Date.now,
    private readonly diagnoseMovement: () => { valid: boolean } = () => ({ valid: true }),
  ) {}

  rollover(input: MovementGenerationRolloverInput): MovementGenerationRolloverResult {
    this.validateInput(input);
    const fingerprint = digest(
      JSON.stringify({
        expectedGeneration: input.expectedGeneration,
        expectedMovementSha256: input.expectedMovementSha256,
        confirmation: input.confirmation,
      }),
    );
    const historyDirectory = join(dirname(this.movementPath), "movement-history");
    const receiptPath = join(
      historyDirectory,
      `rollover-${digest(input.idempotencyKey).slice(0, 32)}.json`,
    );
    const existingReceipt = this.readReceipt(receiptPath);
    if (existingReceipt) {
      if (existingReceipt.fingerprint !== fingerprint)
        throw new MovementGenerationRolloverError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key is already bound to a different rollover request.",
        );
      this.complete(existingReceipt, receiptPath);
      return this.project(existingReceipt, true);
    }

    const movementBytes = readBounded(this.movementPath, MAX_STORE_BYTES);
    const movementHash = digest(movementBytes);
    if (movementHash !== input.expectedMovementSha256)
      throw new MovementGenerationRolloverError(
        "HASH_MISMATCH",
        "Movement store hash changed; no rollover was performed.",
      );
    let movement: unknown;
    try {
      movement = JSON.parse(movementBytes.toString("utf8"));
    } catch {
      throw new MovementGenerationRolloverError(
        "STORE_NOT_RECOVERABLE",
        "Movement store is not valid JSON and has no verifiable generation boundary.",
      );
    }
    if (
      !record(movement) ||
      movement["version"] !== 2 ||
      typeof movement["generation"] !== "string"
    )
      throw new MovementGenerationRolloverError(
        "STORE_NOT_RECOVERABLE",
        "Movement store lacks a supported version-2 generation boundary.",
      );
    if (movement["generation"] !== input.expectedGeneration)
      throw new MovementGenerationRolloverError(
        "GENERATION_MISMATCH",
        "Movement generation changed; no rollover was performed.",
      );
    if (this.diagnoseMovement().valid)
      throw new MovementGenerationRolloverError(
        "STORE_NOT_RECOVERABLE",
        "Movement store is already schema-valid; destructive generation rollover is refused.",
      );

    const deliveryBytes = readBounded(this.deliveryPath, MAX_STORE_BYTES);
    let delivery: unknown;
    try {
      delivery = JSON.parse(deliveryBytes.toString("utf8"));
    } catch {
      throw new MovementGenerationRolloverError(
        "DELIVERY_STORE_MISMATCH",
        "AI-GM delivery store is not valid JSON.",
      );
    }
    if (
      !record(delivery) ||
      delivery["version"] !== 2 ||
      delivery["consumerId"] !== this.consumerId ||
      !Array.isArray(delivery["items"]) ||
      delivery["items"].length > 20_000
    )
      throw new MovementGenerationRolloverError(
        "DELIVERY_STORE_MISMATCH",
        "AI-GM delivery store does not match the configured bounded consumer schema.",
      );
    const watermark = delivery["reconciliationWatermark"];
    if (
      watermark !== undefined &&
      (!record(watermark) || watermark["generation"] !== input.expectedGeneration)
    )
      throw new MovementGenerationRolloverError(
        "DELIVERY_STORE_MISMATCH",
        "AI-GM delivery watermark is not on the expected movement generation boundary.",
      );

    const deliveryHash = digest(deliveryBytes);
    const newGeneration = randomUUID();
    const completedAt = this.now();
    const movementFile = `movement-events-${movementHash}.json`;
    const deliveryFile = `ai-gm-deliveries-${deliveryHash}.json`;
    const currentMovement = Buffer.from(
      JSON.stringify({
        version: 2,
        generation: newGeneration,
        nextSequence: 1,
        events: [],
        eventSequences: {},
        eventHashes: {},
      }),
    );
    const currentDelivery = Buffer.from(
      JSON.stringify({
        version: 2,
        consumerId: this.consumerId,
        items: [],
        reconciliationWatermark: {
          generation: newGeneration,
          sequence: 0,
          cursor: `${newGeneration}:0`,
          initializedAt: completedAt,
          updatedAt: completedAt,
        },
      }),
    );
    const receipt: Receipt = {
      version: 1,
      fingerprint,
      consumerId: this.consumerId,
      status: "completed",
      oldGeneration: input.expectedGeneration,
      newGeneration,
      quarantine: {
        movementFile,
        movementBytes: movementBytes.length,
        movementSha256: movementHash,
        deliveryFile,
        deliveryBytes: deliveryBytes.length,
        deliverySha256: deliveryHash,
        deliveryItemCount: delivery["items"].length,
      },
      current: {
        movementSha256: digest(currentMovement),
        deliverySha256: digest(currentDelivery),
        cursor: `${newGeneration}:0`,
      },
      completedAt,
    };

    mkdirSync(historyDirectory, { recursive: true });
    atomicWrite(receiptPath, Buffer.from(JSON.stringify(receipt)));
    this.complete(
      receipt,
      receiptPath,
      movementBytes,
      deliveryBytes,
      currentMovement,
      currentDelivery,
    );
    return this.project(receipt, false);
  }

  private complete(
    receipt: Receipt,
    receiptPath: string,
    suppliedMovement?: Buffer,
    suppliedDelivery?: Buffer,
    suppliedCurrentMovement?: Buffer,
    suppliedCurrentDelivery?: Buffer,
  ): void {
    const historyDirectory = dirname(receiptPath);
    const movementArchive = join(historyDirectory, receipt.quarantine.movementFile);
    const deliveryArchive = join(historyDirectory, receipt.quarantine.deliveryFile);
    const movementBytes =
      suppliedMovement ??
      readBounded(
        existsSync(movementArchive) ? movementArchive : this.movementPath,
        MAX_STORE_BYTES,
      );
    const deliveryBytes =
      suppliedDelivery ??
      readBounded(
        existsSync(deliveryArchive) ? deliveryArchive : this.deliveryPath,
        MAX_STORE_BYTES,
      );
    if (
      digest(movementBytes) !== receipt.quarantine.movementSha256 ||
      digest(deliveryBytes) !== receipt.quarantine.deliverySha256
    )
      throw new MovementGenerationRolloverError(
        "RECOVERY_CONFLICT",
        "Quarantine evidence does not match the recorded recovery receipt.",
      );
    archiveExact(movementArchive, movementBytes);
    archiveExact(deliveryArchive, deliveryBytes);
    const currentMovement =
      suppliedCurrentMovement ??
      Buffer.from(
        JSON.stringify({
          version: 2,
          generation: receipt.newGeneration,
          nextSequence: 1,
          events: [],
          eventSequences: {},
          eventHashes: {},
        }),
      );
    const currentDelivery =
      suppliedCurrentDelivery ??
      Buffer.from(
        JSON.stringify({
          version: 2,
          consumerId: receipt.consumerId,
          items: [],
          reconciliationWatermark: {
            generation: receipt.newGeneration,
            sequence: 0,
            cursor: receipt.current.cursor,
            initializedAt: receipt.completedAt,
            updatedAt: receipt.completedAt,
          },
        }),
      );
    if (
      digest(currentMovement) !== receipt.current.movementSha256 ||
      digest(currentDelivery) !== receipt.current.deliverySha256
    )
      throw new MovementGenerationRolloverError(
        "RECOVERY_CONFLICT",
        "Recovery receipt does not reproduce the recorded current-store hashes.",
      );
    replaceExpected(this.movementPath, receipt.quarantine.movementSha256, currentMovement);
    replaceExpected(this.deliveryPath, receipt.quarantine.deliverySha256, currentDelivery);
  }

  private readReceipt(path: string): Receipt | undefined {
    if (!existsSync(path)) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readBounded(path, MAX_RECEIPT_BYTES).toString("utf8")) as unknown;
    } catch {
      throw new MovementGenerationRolloverError(
        "RECOVERY_CONFLICT",
        "Recovery receipt is not valid bounded JSON.",
      );
    }
    const quarantine = record(value) ? value["quarantine"] : undefined;
    const current = record(value) ? value["current"] : undefined;
    if (
      !record(value) ||
      value["version"] !== 1 ||
      value["status"] !== "completed" ||
      typeof value["fingerprint"] !== "string" ||
      !SHA256.test(value["fingerprint"]) ||
      value["consumerId"] !== this.consumerId ||
      typeof value["oldGeneration"] !== "string" ||
      value["oldGeneration"].length < 1 ||
      value["oldGeneration"].length > 512 ||
      typeof value["newGeneration"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value["newGeneration"],
      ) ||
      !record(quarantine) ||
      typeof quarantine["movementFile"] !== "string" ||
      !/^movement-events-[a-f0-9]{64}\.json$/.test(quarantine["movementFile"]) ||
      typeof quarantine["deliveryFile"] !== "string" ||
      !/^ai-gm-deliveries-[a-f0-9]{64}\.json$/.test(quarantine["deliveryFile"]) ||
      typeof quarantine["movementSha256"] !== "string" ||
      !SHA256.test(quarantine["movementSha256"]) ||
      typeof quarantine["deliverySha256"] !== "string" ||
      !SHA256.test(quarantine["deliverySha256"]) ||
      !Number.isSafeInteger(quarantine["movementBytes"]) ||
      (quarantine["movementBytes"] as number) < 0 ||
      (quarantine["movementBytes"] as number) > MAX_STORE_BYTES ||
      !Number.isSafeInteger(quarantine["deliveryBytes"]) ||
      (quarantine["deliveryBytes"] as number) < 0 ||
      (quarantine["deliveryBytes"] as number) > MAX_STORE_BYTES ||
      !Number.isSafeInteger(quarantine["deliveryItemCount"]) ||
      (quarantine["deliveryItemCount"] as number) < 0 ||
      (quarantine["deliveryItemCount"] as number) > 20_000 ||
      !record(current) ||
      typeof current["movementSha256"] !== "string" ||
      !SHA256.test(current["movementSha256"]) ||
      typeof current["deliverySha256"] !== "string" ||
      !SHA256.test(current["deliverySha256"]) ||
      current["cursor"] !== `${value["newGeneration"]}:0` ||
      !Number.isSafeInteger(value["completedAt"]) ||
      (value["completedAt"] as number) < 0
    )
      throw new MovementGenerationRolloverError(
        "RECOVERY_CONFLICT",
        "Recovery receipt has an invalid schema.",
      );
    return value as unknown as Receipt;
  }

  private validateInput(input: MovementGenerationRolloverInput): void {
    if (
      input.confirmation !== "quarantine-and-rollover" ||
      input.expectedGeneration.length < 1 ||
      input.expectedGeneration.length > 512 ||
      !SHA256.test(input.expectedMovementSha256) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    )
      throw new MovementGenerationRolloverError(
        "INVALID_REQUEST",
        "Rollover request failed bounded confirmation, generation, hash, or idempotency validation.",
      );
  }

  private project(receipt: Receipt, replayed: boolean): MovementGenerationRolloverResult {
    return {
      status: receipt.status,
      replayed,
      oldGeneration: receipt.oldGeneration,
      newGeneration: receipt.newGeneration,
      quarantine: structuredClone(receipt.quarantine),
      current: structuredClone(receipt.current),
      completedAt: receipt.completedAt,
    };
  }
}
