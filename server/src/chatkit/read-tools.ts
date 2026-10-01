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
import type { WorldCampaignContext } from "../context/world-campaign.js";
import type { ChatKitNativeActions } from "./native-actions.js";

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
    cancel = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
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
  campaign?: WorldCampaignContext;
  actions?: ChatKitNativeActions;
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
    if (operation.startsWith("native_")) {
      if (++run.calls > 12 || !this.options.actions)
        throw new Error("Native action budget unavailable");
      const signal = AbortSignal.any([
        run.signal,
        disconnected,
        AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      ]);
      return this.options.actions.request(run.identity, principal, operation, args, signal);
    }
    const input = object(args);
    if (
      !["context", "scene", "actor", "campaign", "campaign_validate_sources"].includes(operation) ||
      Object.keys(input).some((key) => key !== (operation === "actor" ? "id" : "query")) ||
      (!["actor", "context", "campaign"].includes(operation) && Object.keys(input).length) ||
      (input["query"] !== undefined &&
        (typeof input["query"] !== "string" || input["query"].length > 256))
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
        !CHATKIT_ALLOWED_READS.includes(tool) ||
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
    const world = this.options.campaign ? object(await call("foundry_get_world", {})) : null;
    if (world && identifier(world["_id"] ?? world["id"]) !== run.identity.worldId)
      throw new Error("World changed");
    // Hints are untrusted: both typed messages and actions use the current authoritative active scene.
    const scenes = await call("foundry_list_scenes", {});
    if (!Array.isArray(scenes)) throw new Error("Invalid scene list");
    const active = scenes.map(object).find((scene) => scene["active"] === true);
    if (!active) {
      if (this.options.campaign && ["campaign", "campaign_validate_sources"].includes(operation)) {
        const result = this.options.campaign.retrieve(
          policyPrincipal,
          String(input["query"] ?? ""),
          null,
        );
        await bounded(this.authorize(run.identity, signal), signal);
        return operation === "campaign_validate_sources"
          ? (object(result)["utility"] ?? result)
          : result;
      }
      const data: RecordValue = {
        schemaVersion: 1,
        worldId: run.identity.worldId,
        scene: null,
        actorIds: [],
        reason: "No active scene",
      };
      if (this.options.campaign && operation === "context")
        data["campaign"] = this.options.campaign.retrieve(
          policyPrincipal,
          String(input["query"] ?? ""),
          null,
        );
      await bounded(this.authorize(run.identity, signal), signal);
      return data;
    }
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
    if (operation === "campaign" || operation === "campaign_validate_sources") {
      if (!this.options.campaign) throw new Error("Campaign source unavailable");
      const result = this.options.campaign.retrieve(
        policyPrincipal,
        String(input["query"] ?? ""),
        sceneId,
      );
      await bounded(this.authorize(run.identity, signal), signal);
      return operation === "campaign_validate_sources"
        ? (object(result)["utility"] ?? result)
        : result;
    }
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
        state: actorState(actor),
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
      if (operation === "context" && this.options.campaign) {
        const output = object(data);
        const system = object(await call("foundry_get_system", {}));
        output["rulesSystem"] = {
          id: name(system["id"]),
          version: name(system["version"]),
          title: name(system["title"]),
        };
        const combats = await call("foundry_list_combats", {});
        if (!Array.isArray(combats)) throw new Error("Invalid combat list");
        const combat = combats
          .map(object)
          .find(
            (value) => value["active"] === true && (!value["scene"] || value["scene"] === sceneId),
          );
        output["combat"] = combat
          ? {
              id: identifier(combat["_id"] ?? combat["id"]),
              round: combat["round"] ?? null,
              turn: combat["turn"] ?? null,
            }
          : null;
        output["characters"] = [];
        for (const id of actors.slice(0, 4)) {
          const actor = object(await call("foundry_get_actor", { id }));
          if (identifier(actor["_id"] ?? actor["id"]) !== id) throw new Error("Actor changed");
          output["characters"].push({
            id,
            name: name(actor["name"]),
            type: name(actor["type"]),
            state: actorState(actor),
          });
        }
        output["campaign"] = this.options.campaign.retrieve(
          policyPrincipal,
          String(input["query"] ?? ""),
          sceneId,
        );
        output["recentActionsPolicy"] =
          "Conversation history contains recent actions; no completed action is inferred from untrusted trigger hints.";
      }
    }
    await bounded(this.authorize(run.identity, signal), signal);
    if (operation === "context" && this.options.actions)
      object(data)["nativeActions"] = this.options.actions.recent(principal);
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
        typeof body["operation"] === "string" ? body["operation"] : "",
        body["arguments"] ?? {},
        abort.signal,
      );
      if (!abort.signal.aborted) response.json({ ok: true, result });
    } catch {
      if (!response.destroyed)
        response.status(403).json({
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

const CHATKIT_ALLOWED_READS = [
  "foundry_list_scenes",
  "foundry_get_scene",
  "foundry_get_actor",
  "foundry_get_world",
  "foundry_get_system",
  "foundry_list_combats",
];
function actorState(actor: RecordValue): AiDmJsonValue {
  const system =
    actor["system"] && typeof actor["system"] === "object" && !Array.isArray(actor["system"])
      ? actor["system"]
      : {};
  const attributes =
    system["attributes"] &&
    typeof system["attributes"] === "object" &&
    !Array.isArray(system["attributes"])
      ? system["attributes"]
      : {};
  const output: RecordValue = {};
  for (const key of ["hp", "ac", "movement"]) {
    const value = attributes[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const values: RecordValue = {};
      for (const [field, number] of Object.entries(value))
        if (typeof number === "number" && Number.isFinite(number)) values[field] = number;
      output[key] = values;
    }
  }
  return output;
}
