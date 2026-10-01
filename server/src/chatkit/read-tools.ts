import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";

type RecordValue = Record<string, AiDmJsonValue>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid observation");
  return value as RecordValue;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid identifier");
  return value;
}
function name(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 200) : "";
}

/** Ephemeral server-issued run capabilities. No administrative MCP endpoint is exposed. */
export class ChatKitReadTools {
  private readonly runs = new Map<string, { identity: AiDmAuthenticatedIdentity; signal: AbortSignal; sceneId: string | null; calls: number; expires: number }>();
  constructor(private readonly client: FoundryLocalApiMcpClient, private readonly authorize: (identity: AiDmAuthenticatedIdentity, signal: AbortSignal) => Promise<void>) {}

  begin(identity: AiDmAuthenticatedIdentity, body: unknown, signal: AbortSignal): { token: string; release: () => void } {
    if (!identity.isGm) throw new Error("GM required");
    const request = object(body);
    const params = request["params"] ? object(request["params"]) : {};
    const action = params["action"] ? object(params["action"]) : {};
    const payload = action["payload"] ? object(action["payload"]) : {};
    const context = payload["context"] ? object(payload["context"]) : {};
    const sceneId = context["sceneId"] === undefined ? null : identifier(context["sceneId"]);
    const token = randomBytes(32).toString("hex");
    for (const [key, run] of this.runs) if (run.expires < Date.now()) this.runs.delete(key);
    if (this.runs.size >= 100) throw new Error("Read run limit reached");
    this.runs.set(token, { identity, signal, sceneId, calls: 0, expires: Date.now() + 300_000 });
    return { token, release: () => this.runs.delete(token) };
  }

  async execute(token: string, operation: string, args: unknown, disconnected: AbortSignal): Promise<AiDmJsonValue> {
    const run = this.runs.get(token);
    if (!run || run.expires < Date.now() || run.signal.aborted) throw new Error("Read run expired");
    const input = object(args);
    if (!['context', 'scene', 'actor'].includes(operation) || Object.keys(input).some(key => key !== "id") || (operation !== "actor" && Object.keys(input).length)) throw new Error("Unsupported read");
    if (++run.calls > 12) throw new Error("Read budget exhausted");
    const signal = AbortSignal.any([run.signal, disconnected, AbortSignal.timeout(10_000)]);
    await this.authorize(run.identity, signal);
    const call = async (tool: string, argumentsValue: RecordValue) => {
      signal.throwIfAborted();
      return this.client.callTool({ name: tool, arguments: argumentsValue, idempotencyKey: null }, { signal, timeout: 10_000, maxTotalTimeout: 10_000 });
    };
    if (!run.sceneId) {
      const scenes = await call("foundry_list_scenes", {});
      if (!Array.isArray(scenes)) throw new Error("Invalid scene list");
      const active = scenes.map(object).find(scene => scene["active"] === true);
      if (active) run.sceneId = identifier(active["_id"] ?? active["id"]);
    }
    if (!run.sceneId) return { scene: null, actors: [], reason: "No active scene" };
    const scene = object(await call("foundry_get_scene", { id: run.sceneId }));
    if (identifier(scene["_id"] ?? scene["id"]) !== run.sceneId) throw new Error("Scene changed");
    const tokens = (Array.isArray(scene["tokens"]) ? scene["tokens"] : []).slice(0, 40).map(object);
    const actors = [...new Set(tokens.flatMap(token => typeof token["actorId"] === "string" ? [identifier(token["actorId"])] : []))];
    if (operation === "actor") {
      const actorId = identifier(input["id"]);
      if (!actors.includes(actorId)) throw new Error("Actor is outside the current scene");
      const actor = object(await call("foundry_get_actor", { id: actorId }));
      if (identifier(actor["_id"] ?? actor["id"]) !== actorId) throw new Error("Actor changed");
      return { id: actorId, name: name(actor["name"]), type: name(actor["type"]) };
    }
    return { scene: { id: run.sceneId, name: name(scene["name"]), active: scene["active"] === true }, tokens: tokens.map(token => ({ id: identifier(token["_id"] ?? token["id"]), name: name(token["name"]), actorId: typeof token["actorId"] === "string" ? token["actorId"] : null, hidden: token["hidden"] === true })), actorIds: actors };
  }

  readonly handler: RequestHandler = async (request, response) => {
    response.set("Cache-Control", "no-store");
    const abort = new AbortController();
    const close = () => { if (!response.writableEnded) abort.abort(); };
    response.on("close", close);
    try {
      if (request.get("origin")) throw new Error("Internal requests only");
      const body = object(request.body);
      if (Object.keys(body).some(key => !["operation", "arguments"].includes(key))) throw new Error("Unsupported fields");
      const result = await this.execute(request.get("x-chatkit-read-run") ?? "", String(body["operation"]), body["arguments"] ?? {}, abort.signal);
      if (!abort.signal.aborted) response.json({ result });
    } catch {
      if (!response.destroyed) response.status(403).json({ error: "Authorized bounded Foundry read unavailable" });
    } finally { response.off("close", close); }
  };
}
