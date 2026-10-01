import { createHash } from "node:crypto";

import {
  AI_DM_MAX_JSON_CHARACTERS,
  parseBoundedAiDmJson,
  type AiDmJsonValue,
} from "@foundry-ai-dungeon-master/shared";

import { AiDmStorageError } from "./errors.js";

const MAX_DEPTH = 32;
const MAX_STRING_LENGTH = 64_000;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /api.?key|authorization|cookie|password|secret|credential|private.?key|access.?token|refresh.?token|session(?:id)?/i;

function normalize(value: unknown, depth: number): AiDmJsonValue {
  if (depth > MAX_DEPTH) {
    throw new AiDmStorageError("JSON_DEPTH_EXCEEDED", "Operational JSON exceeds the depth limit.");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AiDmStorageError(
        "JSON_INVALID_NUMBER",
        "Operational JSON contains a non-finite number.",
      );
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      throw new AiDmStorageError(
        "JSON_STRING_TOO_LARGE",
        "Operational JSON contains an oversized string.",
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, AiDmJsonValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) continue;
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : normalize(child, depth + 1);
    }
    return output;
  }
  throw new AiDmStorageError(
    "JSON_UNSUPPORTED_VALUE",
    `Operational JSON cannot contain ${typeof value}.`,
  );
}

function sortKeys(value: AiDmJsonValue): AiDmJsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}

export interface StoredJson<T = AiDmJsonValue> {
  value: T;
  text: string;
  digest: string;
}

/** Redacts credential-shaped keys, validates JSON shape, and enforces the shared size bound. */
export function prepareStoredJson<T = AiDmJsonValue>(value: unknown): StoredJson<T> {
  const normalized = normalize(value, 0);
  const parsed = parseBoundedAiDmJson(normalized) as T;
  const text = JSON.stringify(sortKeys(parsed as AiDmJsonValue));
  if (text.length > AI_DM_MAX_JSON_CHARACTERS) {
    throw new AiDmStorageError("JSON_TOO_LARGE", "Operational JSON exceeds the size limit.");
  }
  return {
    value: parsed,
    text,
    digest: createHash("sha256").update(text).digest("hex"),
  };
}

export function parseStoredJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
