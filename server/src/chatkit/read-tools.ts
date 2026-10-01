import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type {
  AiDmAuthenticatedIdentity,
  AiDmJsonValue,
  AiDmRunPrincipal,
} from "@foundry-ai-dungeon-master/shared";
import {
  metadataAllows,
  validateArguments,
  type FoundryLocalApiMcpClient,
  type TrustedToolCatalog,
} from "../tool-catalog/index.js";

type RecordValue = Record<string, AiDmJsonValue>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid observation");
  return value as RecordValue;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("Invalid identifier");
  return value;
}
function name(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 200) : "";
}

/** Hard deadline even when a provider ignores cooperative cancellation. Late results are discarded. */
export async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void work.catch(() => {});
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason ?? new Error("Cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export interface ChatKitReadOptions {
  internalSecret: string;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Ephemeral run-scoped adapter. Python sees only scene/actor summaries, never the administrative catalog. */
export class ChatKitReadTools {
  private readonly runs = new Map<
    string,
    {
      identity: AiDmAuthenticatedIdentity;
      signal: AbortSignal;
      threadId: string | null;
      calls: number;
      expires: number;
    }
  >();
  constructor(
    private readonly client: FoundryLocalApiMcpClient,
    private readonly authorize: (
      identity: AiDmAuthenticatedIdentity,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly catalog: TrustedToolCatalog,
    private readonly options: ChatKitReadOptions,
  ) {
    if (!options.internalSecret) throw new Error("Internal adapter authentication required");
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  begin(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    signal: AbortSignal,
  ): { token: string; release: () => void } {
    if (!identity.isGm) throw new Error("GM required");
    signal.throwIfAborted();
    const request = object(body);
    const params = request["params"] ? object(request["params"]) : {};
    const threadId = params["thread_id"] === undefined ? null : identifier(params["thread_id"]);
    const token = randomBytes(32).toString("hex");
    for (const [key, run] of this.runs) if (run.expires <= this.now()) this.runs.delete(key);
    if (this.runs.size >= 100) throw new Error("Read run limit reached");
    this.runs.set(token, {
      identity: structuredClone(identity),
      signal,
      threadId,
      calls: 0,
      expires: this.now() + (this.options.ttlMs ?? 300_000),
    });
    return { token, release: () => this.runs.delete(token) };
  }

  async execute(
    token: string,
    principal: { worldId: string; userId: string; threadId: string },
    operation: string,
    args: unknown,
    disconnected: AbortSignal,
  ): Promise<AiDmJsonValue> {
    const run = this.runs.get(token);
    if (!run || run.expires <= this.now() || run.signal.aborted)
      throw new Error("Read run expired");
    if (
      principal.worldId !== run.identity.worldId ||
      principal.userId !== run.identity.userId ||
      !principal.threadId ||
      (run.threadId !== null && principal.threadId !== run.threadId)
    )
      throw new Error("Read run scope mismatch");
    identifier(principal.threadId);
    // New ChatKit threads are assigned inside Python; only the authenticated sidecar may bind once.
    run.threadId ??= principal.threadId;
    const input = object(args);
    if (
      !["context", "scene", "actor"].includes(operation) ||
      Object.keys(input).some((key) => key !== "id") ||
      (operation !== "actor" && Object.keys(input).length)
    )
      throw new Error("Unsupported read");
    const actorId = operation === "actor" ? identifier(input["id"]) : null;
    if (++run.calls > 12) throw new Error("Read budget exhausted");
    const signal = AbortSignal.any([
      run.signal,
      disconnected,
      AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    ]);
    await bounded(this.authorize(run.identity, signal), signal);
    await bounded(this.catalog.refresh(), signal);
    const policyPrincipal: AiDmRunPrincipal = {
      ...run.identity,
      connectionId: token,
      role: 4,
      authorizedAudienceKinds: ["gm"],
      permissionSnapshotRevision: "current-live-check",
    };
    const call = async (tool: string, argumentsValue: RecordValue) => {
      signal.throwIfAborted();
      const record = this.catalog.record(tool);
      if (
        !["foundry_list_scenes", "foundry_get_scene", "foundry_get_actor"].includes(tool) ||
        !record ||
        record.descriptor.availability !== "available" ||
        !record.metadata.effects.includes("read") ||
        !metadataAllows(policyPrincipal, record.metadata, "execute") ||
        validateArguments(record.definition.inputSchema, argumentsValue).length
      )
        throw new Error("Read catalog policy denied");
      await bounded(this.authorize(run.identity, signal), signal);
      const value = await bounded(
        this.client.callTool(
          { name: tool, arguments: argumentsValue, idempotencyKey: null },
          {
            signal,
            timeout: this.options.timeoutMs ?? 10_000,
            maxTotalTimeout: this.options.timeoutMs ?? 10_000,
          },
        ),
        signal,
      );
      await bounded(this.authorize(run.identity, signal), signal);
      signal.throwIfAborted();
      if (run.expires <= this.now() || !this.runs.has(token)) throw new Error("Read run expired");
      return value;
    };
    // Hints are untrusted: both typed messages and actions use the current authoritative active scene.
    const scenes = await call("foundry_list_scenes", {});
    if (!Array.isArray(scenes)) throw new Error("Invalid scene list");
    const active = scenes.map(object).find((scene) => scene["active"] === true);
    if (!active)
      return {
        schemaVersion: 1,
        worldId: run.identity.worldId,
        scene: null,
        actorIds: [],
        reason: "No active scene",
      };
    const sceneId = identifier(active["_id"] ?? active["id"]);
    const scene = object(await call("foundry_get_scene", { id: sceneId }));
    if (identifier(scene["_id"] ?? scene["id"]) !== sceneId || scene["active"] !== true)
      throw new Error("Scene changed");
    const tokens = (Array.isArray(scene["tokens"]) ? scene["tokens"] : []).slice(0, 40).map(object);
    const actors = [
      ...new Set(
        tokens.flatMap((token) =>
          typeof token["actorId"] === "string" ? [identifier(token["actorId"])] : [],
        ),
      ),
    ];
    let data: AiDmJsonValue;
    if (actorId !== null) {
      if (!actors.includes(actorId)) throw new Error("Actor is outside the current scene");
      const actor = object(await call("foundry_get_actor", { id: actorId }));
      if (identifier(actor["_id"] ?? actor["id"]) !== actorId) throw new Error("Actor changed");
      data = {
        schemaVersion: 1,
        worldId: run.identity.worldId,
        id: actorId,
        name: name(actor["name"]),
        type: name(actor["type"]),
      };
    } else {
      data = {
        schemaVersion: 1,
        worldId: run.identity.worldId,
        scene: { id: sceneId, name: name(scene["name"]), active: true },
        tokens: tokens.map((token) => ({
          id: identifier(token["_id"] ?? token["id"]),
          name: name(token["name"]),
          actorId: typeof token["actorId"] === "string" ? token["actorId"] : null,
          hidden: token["hidden"] === true,
        })),
        actorIds: actors,
      };
    }
    if (Buffer.byteLength(JSON.stringify(data)) > 24_000)
      throw new Error("Read result exceeds budget");
    return data;
  }

  readonly handler: RequestHandler = async (request, response) => {
    response.set("Cache-Control", "no-store");
    const abort = new AbortController();
    const close = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.on("close", close);
    request.on("aborted", close);
    try {
      const supplied = Buffer.from(request.get("x-chatkit-secret") ?? "");
      const expected = Buffer.from(this.options.internalSecret);
      if (
        request.get("origin") ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new Error("Internal requests only");
      const body = object(request.body);
      if (Object.keys(body).some((key) => !["operation", "arguments"].includes(key)))
        throw new Error("Unsupported fields");
      const principal = {
        worldId: request.get("x-chatkit-world") ?? "",
        userId: request.get("x-chatkit-user") ?? "",
        threadId: request.get("x-chatkit-thread") ?? "",
      };
      const result = await this.execute(
        request.get("x-chatkit-read-run") ?? "",
        principal,
        String(body["operation"]),
        body["arguments"] ?? {},
        abort.signal,
      );
      if (!abort.signal.aborted) response.json({ ok: true, result });
    } catch {
      if (!response.destroyed)
        response
          .status(403)
          .json({
            ok: false,
            error: {
              code: "READ_UNAVAILABLE",
              message: "Authorized bounded Foundry read unavailable",
            },
          });
    } finally {
      response.off("close", close);
      request.off("aborted", close);
    }
  };
}
