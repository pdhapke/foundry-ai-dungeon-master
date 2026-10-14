import { bounded } from "./bounded-call.js";
import { PreparedContext } from "./prepared-context.js";
import { projectPlayerPerception, projectPlayerSurroundings, unavailablePerception } from "./player-perception.js";
import type { PlayerDescriptionPlan } from "../context/world-campaign.js";
import { hashText } from "../context/hash.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type {
  AiDmAuthenticatedIdentity,
  AiDmJsonValue,
  AiDmRunPrincipal,
  AiDmMutationBoundaryAcknowledgement,
} from "@foundry-ai-dungeon-master/shared";
import {
  metadataAllows,
  validateArguments,
  type FoundryLocalApiMcpClient,
  type TrustedToolCatalog,
} from "../tool-catalog/index.js";
import type { WorldCampaignContext } from "../context/world-campaign.js";
import type { ChatKitNativeActions } from "./native-actions.js";
import type { SessionRequestAuthorization } from "./pause-request.js";
import type { ChatKitCampaignActions } from "./campaign-actions.js";
import type { ChatKitWorldFileActions } from "./world-file-actions.js";
import { ChatKitCatalogTools } from "./catalog-tools.js";
import { createHash } from "node:crypto";
import { stableJson } from "../context/hash.js";
import type { ChatKitToolAuditEvent, ChatKitToolAuditObserver } from "./tool-audit.js";
import { latencyEvent, latencySpan, withLatencyTrace } from "../latency-trace.js";
import { narrationCompletion, narrationReceiptMatches } from "./narration-request.js";
import type { RoutineCompletionContract } from "./routine-completion.js";

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

/** Preserve essential overview while explicitly shedding optional context under transport limits. */
function fitContext(data: RecordValue): RecordValue {
  const fits = () => Buffer.byteLength(JSON.stringify(data)) <= 24_000;
  if (fits()) return data;
  data["contextTruncated"] = true;
  data["contextIssue"] =
    "Optional snapshot details omitted to preserve campaign overview within UTF-8 transport budget";
  delete data["nativeActions"];
  delete data["worldFileActions"];
  if (data["party"] && typeof data["party"] === "object" && !Array.isArray(data["party"]))
    object(data["party"])["candidates"] = [];
  if (!fits()) data["tokens"] = [];
  const campaign =
    data["campaign"] && typeof data["campaign"] === "object" && !Array.isArray(data["campaign"])
      ? object(data["campaign"])
      : null;
  if (campaign && Array.isArray(campaign["excerpts"])) {
    while (!fits() && campaign["excerpts"].length) campaign["excerpts"].pop();
    campaign["partial"] = true;
  }
  if (!fits()) {
    data["characters"] = [];
    if (data["party"] && typeof data["party"] === "object" && !Array.isArray(data["party"])) {
      object(data["party"])["members"] = [];
      object(data["party"])["status"] = "partial";
    }
  }
  return data;
}

export { bounded } from "./bounded-call.js";

export interface ChatKitReadOptions {
  /** OFF until the reviewed server and native ordering contract passes validation. */
  allowMutationBoundary?: boolean;
  internalSecret: string;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
  campaign?: WorldCampaignContext;
  actions?: ChatKitNativeActions;
  campaignActions?: ChatKitCampaignActions;
  worldFiles?: ChatKitWorldFileActions;
  toolAudit?: ChatKitToolAuditObserver;
  preparationAction?: (identity: AiDmAuthenticatedIdentity, body: unknown, signal: AbortSignal) => Promise<AiDmJsonValue>;
}

/** Ephemeral run-scoped adapter. Python sees only scene/actor summaries, never the administrative catalog. */
export class ChatKitReadTools {
  private readonly preparedCatalog = new PreparedContext<{ catalogRevision: string }>();
  private readonly preparationScopes = new Map<string, string>();
  invalidatePreparation(_identity?: AiDmAuthenticatedIdentity, reason = "connection-gap"): void {
    // Conservative global invalidation: no dependable client event sequence exists.
    this.preparedCatalog.invalidate();
    this.preparationScopes.clear();
    latencyEvent(`preparation:invalidate:${reason}`);
  }
  private async prepareCatalog(identity: AiDmAuthenticatedIdentity, signal: AbortSignal): Promise<{ value: { catalogRevision: string }; hit: boolean; ageMs: number }> {
    const key = JSON.stringify([identity.worldId, identity.userId, identity.clientId, identity.lane, identity.isGm, this.preparationScopes.get(identity.clientId) ?? "command"]);
    const prepared = await this.preparedCatalog.get(key, signal, async () => {
      const snapshot = await this.catalog.refresh();
      return { catalogRevision: snapshot.catalogRevision };
    });
    // Another consumer may have refreshed the shared catalog meanwhile.
    if (prepared.value.catalogRevision !== this.catalog.snapshot().catalogRevision) {
      this.preparedCatalog.invalidate();
      return this.prepareCatalog(identity, signal);
    }
    latencyEvent(prepared.hit ? "preparation:catalog-hit" : "preparation:catalog-miss");
    return prepared;
  }
  async prepare(identity: AiDmAuthenticatedIdentity, signal: AbortSignal, configurationRevision = "default", connectionRevision = "connected"): Promise<Record<string, unknown>> {
    if (!identity.isGm) throw new Error("GM required");
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 10_000)]);
    const started = performance.now();
    await bounded(this.authorize(identity, boundedSignal), boundedSignal);
    const scope = JSON.stringify([configurationRevision, connectionRevision]);
    if (this.preparationScopes.get(identity.clientId) !== scope) this.preparedCatalog.invalidate();
    if (this.preparationScopes.size >= 32) this.preparationScopes.clear();
    this.preparationScopes.set(identity.clientId, scope);
    const [catalog, overview] = await Promise.all([
      this.prepareCatalog(identity, boundedSignal),
      Promise.resolve().then(() => this.options.campaign?.overview({ ...identity, connectionId: identity.clientId, role: 4, authorizedAudienceKinds: ["gm"], permissionSnapshotRevision: "current-live-check" })),
    ]);
    await bounded(this.authorize(identity, boundedSignal), boundedSignal);
    boundedSignal.throwIfAborted();
    latencyEvent("preparation:context-duration", performance.now() - started);
    return { schemaVersion: 1, status: "prepared", catalogRevision: catalog.value.catalogRevision,
      catalogHit: catalog.hit, snapshotAgeMs: catalog.ageMs, conservativeRefreshMs: 15_000,
      campaignStatus: overview && typeof overview === "object" && !Array.isArray(overview) ? overview["status"] : "unavailable",
      scope: "Reusable catalog and existing campaign parser only; live world/scene/combat and authorization checked on every command" };
  }
  private readonly runs = new Map<
    string,
    {
      identity: AiDmAuthenticatedIdentity;
      signal: AbortSignal;
      threadId: string | null;
      calls: number;
      expires: number;
      discovery?: ChatKitCatalogTools;
      requestedPaused?: boolean;
      sessionKinds?: string[];
      sessionAuthorization?: SessionRequestAuthorization;
      traceId?: string;
      phase: "active" | "sealing" | "revoked";
      activeCalls: number;
      mutationAttempts: number;
      nonEligibleCall: boolean;
      narrationContract?: RoutineCompletionContract;
      confirmedReceipt?: AiDmJsonValue;
      boundary?: AiDmMutationBoundaryAcknowledgement;
      releaseMutationSlot?: (boundary: AiDmMutationBoundaryAcknowledgement) => void;
      slotReleased?: boolean;
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
    explicitPauseRequest?: SessionRequestAuthorization,
    traceId?: string,
    releaseMutationSlot?: (boundary: AiDmMutationBoundaryAcknowledgement) => void,
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
      phase: "active", activeCalls: 0, mutationAttempts: 0, nonEligibleCall: false,
      ...(narrationCompletion(body) ? { narrationContract: narrationCompletion(body)! } : {}),
      ...(releaseMutationSlot ? { releaseMutationSlot } : {}),
      identity: structuredClone(identity),
      signal,
      threadId,
      calls: 0,
      expires: this.now() + (this.options.ttlMs ?? 300_000),
      ...(traceId ? { traceId } : {}),
      ...(explicitPauseRequest ? { requestedPaused: explicitPauseRequest.paused } : {}),
      ...(explicitPauseRequest?.sessionKinds
        ? { sessionKinds: [...explicitPauseRequest.sessionKinds] }
        : {}),
      ...(explicitPauseRequest
        ? { sessionAuthorization: structuredClone(explicitPauseRequest) }
        : {}),
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
    if (!run || run.expires <= this.now() || run.signal.aborted || disconnected.aborted || principal.worldId !== run.identity.worldId || principal.userId !== run.identity.userId || !principal.threadId || (run.threadId !== null && run.threadId !== principal.threadId))
      throw new Error("Read run expired or scope mismatch");
    identifier(principal.threadId); run.threadId ??= principal.threadId;
    if (operation === "release_mutation_capability") {
      const input = object(args);
      if (input["version"] !== 1 || Object.keys(input).length !== 1 || !this.options.allowMutationBoundary || !run.releaseMutationSlot || !run.narrationContract)
        throw new Error("Mutation boundary unavailable");
      if (run.phase === "sealing" || run.activeCalls || run.mutationAttempts !== 1 || run.nonEligibleCall || !run.confirmedReceipt)
        throw new Error("Complete sole confirmed mechanics required");
      let currentAuthorityChecked = false;
      if (run.phase === "active") {
        // Irreversible seal precedes asynchronous authorization. Concurrent or
        // delayed calls cannot enter while the current-GM check is in flight.
        run.phase = "sealing";
        const signal = AbortSignal.any([run.signal, disconnected, AbortSignal.timeout(this.options.timeoutMs ?? 10000)]);
        await bounded(this.authorize(run.identity, signal), signal); signal.throwIfAborted();
        currentAuthorityChecked = true;
        if (!this.runs.has(token) || run.expires <= this.now()) throw new Error("Read run expired");
        const receipt = object(run.confirmedReceipt);
        run.boundary = { version: 1, mutationCapability: "permanently-revoked",
          receiptDigest: createHash("sha256").update(stableJson(run.confirmedReceipt)).digest("hex"),
          stateRevision: createHash("sha256").update(stableJson(receipt["state"] ?? { paused: receipt["paused"]! })).digest("hex"),
          stateRevisionKind: "receipt-state-digest", scope: "confirmed-receipt-observation; may be superseded" };
        run.phase = "revoked";
      }
      if (!run.boundary) throw new Error("Mutation boundary acknowledgement unavailable");
      if (!currentAuthorityChecked && run.phase === "revoked" && !run.slotReleased) {
        const signal = AbortSignal.any([run.signal, disconnected, AbortSignal.timeout(this.options.timeoutMs ?? 10000)]);
        await bounded(this.authorize(run.identity, signal), signal); signal.throwIfAborted();
        if (!this.runs.has(token) || run.expires <= this.now()) throw new Error("Read run expired");
      }
      if (!run.slotReleased) { run.releaseMutationSlot(run.boundary); run.slotReleased = true; latencyEvent("mutation-capability-revoked-and-slot-released"); }
      return { ...run.boundary };
    }
    if (run.phase !== "active") throw new Error("Run mutation capability permanently revoked; narration only");
    run.activeCalls++;
    const eligibleMutation = ["native_core_action", "native_set_pause_core"].includes(operation);
    if (eligibleMutation) run.mutationAttempts++;
    else if (!["initial_context", "control_context"].includes(operation)) run.nonEligibleCall = true;
    try {
      const result = await this.executeOperation(token, principal, operation, args, disconnected);
      if (eligibleMutation && run.narrationContract && narrationReceiptMatches(run.narrationContract, operation, result) && object(result)["worldId"] === run.identity.worldId)
        run.confirmedReceipt = structuredClone(result);
      return result;
    } finally { run.activeCalls--; }
  }

  private async executeOperation(
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
    if (["tool_search", "tool_load", "tool_execute"].includes(operation)) {
      const signal = AbortSignal.any([
        run.signal,
        disconnected,
        AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      ]);
      const authorize = async (current: AbortSignal) => {
        current.throwIfAborted();
        if (!this.runs.has(token) || run.expires <= this.now())
          throw new Error("Discovery run expired");
        await this.authorize(run.identity, current);
      };
      run.discovery ??= new ChatKitCatalogTools(
        this.client,
        {
          ...run.identity,
          connectionId: token,
          role: 4,
          authorizedAudienceKinds: ["gm"],
          permissionSnapshotRevision: "current-live-check",
        },
        authorize,
        (operation, args, current) => this.execute(token, principal, operation, args, current),
        Boolean(this.options.actions),
        Boolean(this.options.worldFiles),
        Boolean(this.options.preparationAction),
      );
      return bounded(run.discovery.execute(operation, args, signal), signal);
    }
    if (operation === 'preparation_workflow') {
      if (++run.calls > 12 || !this.options.preparationAction) throw new Error('Preparation budget unavailable');
      const signal = AbortSignal.any([run.signal, disconnected, AbortSignal.timeout(this.options.timeoutMs ?? 10000)]);
      await bounded(this.authorize(run.identity, signal), signal);
      const body=object(args),preparationInput=object(body['input']);
      const generationScoped=String(body['operation']).startsWith('battlemap-generation-')||preparationInput['generationId']!==undefined;
      if(generationScoped&&preparationInput['threadId']!==undefined&&preparationInput['threadId']!==principal.threadId)throw new Error('FOREST_GENERATION_THREAD_CHANGED');
      const scopedArgs=generationScoped?{...body,input:{...preparationInput,threadId:principal.threadId}}:args;
      const result = await bounded(this.options.preparationAction(run.identity, scopedArgs as AiDmJsonValue, signal), signal);
      await bounded(this.authorize(run.identity, signal), signal);
      return result;
    }
    if (["campaign_read", "campaign_propose", "campaign_proposals"].includes(operation)) {
      if (++run.calls > 12 || !this.options.campaignActions)
        throw new Error("Campaign action budget unavailable");
      const signal = AbortSignal.any([
        run.signal,
        disconnected,
        AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      ]);
      return this.options.campaignActions.request(run.identity, principal, operation, args, signal);
    }
    if (operation.startsWith("world_file_")) {
      if (++run.calls > 12 || !this.options.worldFiles) throw new Error("World file budget unavailable");
      const signal = AbortSignal.any([run.signal, disconnected, AbortSignal.timeout(this.options.timeoutMs ?? 10000)]);
      if (operation === "world_file_authorize") {
        signal.throwIfAborted(); await bounded(this.authorize(run.identity, signal), signal); signal.throwIfAborted();
        if (!run.sessionAuthorization?.worldControl?.manualRequest || !/^[a-f0-9]{64}$/.test(run.sessionAuthorization.worldControl.requestDigest)) throw new Error("Current GM world file request required");
        return { authorized: true };
      }
      const selected = operation.slice("world_file_".length);
      if (!["list", "read", "write", "mkdir", "delete", "recover"].includes(selected)) throw new Error("World file operation denied");
      return this.options.worldFiles.request(run.identity, principal, selected as "list" | "read" | "write" | "mkdir" | "delete" | "recover", args, run.sessionAuthorization, signal);
    }
    if (operation.startsWith("native_")) {
      if (++run.calls > 12 || !this.options.actions)
        throw new Error("Native action budget unavailable");
      const signal = AbortSignal.any([
        run.signal,
        disconnected,
        AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      ]);
      return this.options.actions.request(
        run.identity,
        principal,
        operation,
        operation === "native_set_pause_core" ? { ...object(args), actionId: token } :
        ["native_core_action", "native_core_move_batch"].includes(operation) ? { ...object(args), actionId: createHash("sha256").update(token + stableJson(object(args))).digest("hex") } : args,
        signal,
        run.requestedPaused,
        run.sessionAuthorization,
      );
    }
    if (operation === "token_perception" || operation === "player_surroundings") {
      if (++run.calls > 12) throw new Error("Read budget exhausted");
      const input = object(args);
      if (Object.keys(input).some(key => !["sceneId", "tokenId", "effectiveUserId", "clientId"].includes(key))) throw new Error("Invalid selected perception request");
      const selected = { sceneId: identifier(input["sceneId"]), tokenId: identifier(input["tokenId"]), effectiveUserId: identifier(input["effectiveUserId"]), clientId: identifier(input["clientId"]) };
      const signal = AbortSignal.any([run.signal, disconnected, AbortSignal.timeout(this.options.timeoutMs ?? 10000)]);
      await bounded(this.authorize(run.identity, signal), signal); signal.throwIfAborted();
      // Safe player actions deliberately bypass GM initial_context. Initialize
      // their live catalog here rather than relying on a prior private chat.
      await bounded(this.catalog.refresh(), signal); signal.throwIfAborted();
      const descriptor = this.catalog.record("foundry_get_token_visibility");
      const policy = { ...run.identity, connectionId: token, role: 4, authorizedAudienceKinds: ["gm"] as const, permissionSnapshotRevision: "current-live-check" };
      const emptyPlan: PlayerDescriptionPlan = { sourceRevision: hashText("no-approved-campaign-description"), points: [], descriptions: [] };
      const plan = operation === "player_surroundings" ? this.options.campaign?.playerDescriptionPlan({ ...policy, authorizedAudienceKinds: [...policy.authorizedAudienceKinds] }, selected.sceneId) ?? emptyPlan : emptyPlan;
      const unavailable = (reason: Parameters<typeof unavailablePerception>[1], status: "unavailable" | "stale" = "unavailable") => {
        const value = unavailablePerception(selected, reason, status);
        return operation === "player_surroundings" ? projectPlayerSurroundings(value, selected, run.identity.worldId, plan) : value;
      };
      const nativeArguments = operation === "player_surroundings" ? { ...selected, queryPoints: plan.points } : selected;
      if (!descriptor || descriptor.descriptor.availability !== "available" || !descriptor.metadata.effects.includes("read") ||
        !metadataAllows({ ...policy, authorizedAudienceKinds: [...policy.authorizedAudienceKinds] }, descriptor.metadata, "execute") || validateArguments(descriptor.definition.inputSchema, nativeArguments).length)
        throw new Error("Selected perception read unavailable");
      let result: unknown;
      let clientChanged = false;
      try {
        const currentClient = async () => {
          const report = object(await bounded(this.client.callTool({ name: "foundry_get_capability_report", arguments: {}, idempotencyKey: null }, { signal, timeout: this.options.timeoutMs ?? 10000 }), signal));
          return Array.isArray(report["clients"]) ? report["clients"].find(value => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            return value["clientId"] === selected.clientId && value["userId"] === selected.effectiveUserId && value["lane"] === "player" && value["isGM"] === false && value["optedIn"] === true;
          }) as RecordValue | undefined : undefined;
        };
        const before = await currentClient();
        if (!before || typeof before["connectedAt"] !== "number") throw Object.assign(new Error("Selected player unavailable"), { code: "NOT_CONNECTED" });
        const generation = before["connectedAt"];
        result = await bounded(this.client.callTool({ name: "foundry_get_token_visibility", arguments: nativeArguments, idempotencyKey: null },
          { signal, timeout: this.options.timeoutMs ?? 10000, maxTotalTimeout: this.options.timeoutMs ?? 10000 }), signal);
        const after = await currentClient();
        clientChanged = !after || after["connectedAt"] !== generation;
      } catch (error) {
        // Revocation/cancellation is not an availability result and must still deny the run.
        await bounded(this.authorize(run.identity, signal), signal); signal.throwIfAborted();
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        return unavailable(code === "NOT_CONNECTED" ? "PLAYER_CLIENT_UNAVAILABLE" : code === "TIMEOUT" ? "PERCEPTION_TIMEOUT" : "PERCEPTION_UNAVAILABLE");
      }
      await bounded(this.authorize(run.identity, signal), signal); signal.throwIfAborted();
      if (clientChanged) return unavailable("STATE_CHANGED", "stale");
      if (operation === "player_surroundings") {
        const refreshed = this.options.campaign?.playerDescriptionPlan({ ...policy, authorizedAudienceKinds: [...policy.authorizedAudienceKinds] }, selected.sceneId) ?? emptyPlan;
        if (refreshed.sourceRevision !== plan.sourceRevision) return unavailable("STATE_CHANGED", "stale");
        return projectPlayerSurroundings(result, selected, run.identity.worldId, plan);
      }
      return projectPlayerPerception(result, selected, run.identity.worldId);
    }
    if (operation === "control_context") {
      if (Object.keys(object(args)).length || ++run.calls > 12) throw new Error("Invalid control context");
      const signal = AbortSignal.any([run.signal, disconnected]);
      await bounded(this.authorize(run.identity, signal), signal);
      const policyPrincipal: AiDmRunPrincipal = { ...run.identity, connectionId: token, role: 4,
        authorizedAudienceKinds: ["gm"], permissionSnapshotRevision: "current-live-check" };
      return fitContext({ worldId: run.identity.worldId, campaignOverview: this.options.campaign?.overview(policyPrincipal) ??
        { status: "unavailable", text: "", partyActorIds: [] }, contextScope: "pause-control-only; request scene or campaign tools for other context" });
    }
    const input = object(args);
    if (
      !["initial_context", "context", "scene", "actor", "campaign", "campaign_validate_sources"].includes(operation) ||
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
    const timed = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      let outcome = "error";
      try { const result = await work(); outcome = "returned"; return result; }
      finally { latencyEvent(`context:${step}`, performance.now() - started, outcome); console.info(JSON.stringify({ type: "context-timing", traceId: run.traceId ?? "",
        runCorrelation: createHash("sha256").update(token).digest("hex"), operation, step,
        atMs: Date.now(), durationMs: performance.now() - started, outcome })); }
    };
    await timed("authorization", () => bounded(this.authorize(run.identity, signal), signal));
    await timed("catalog-refresh", () => this.prepareCatalog(run.identity, signal));
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
      // Initial context is one bounded read-only disclosure: authority is checked
      // before dispatch, between dependent read phases, and before returning any
      // data. MCP still authenticates every read. Never reuse this boundary for
      // mutations or cache it across turns.
      if (operation !== "initial_context")
        await timed(`${tool}:authorization-before`, () => bounded(this.authorize(run.identity, signal), signal));
      const value = await timed(`${tool}:mcp-read`, () => bounded(
        this.client.callTool(
          { name: tool, arguments: argumentsValue, idempotencyKey: null },
          {
            signal,
            timeout: this.options.timeoutMs ?? 10_000,
            maxTotalTimeout: this.options.timeoutMs ?? 10_000,
          },
        ),
        signal,
      ));
      if (operation !== "initial_context")
        await timed(`${tool}:authorization-after`, () => bounded(this.authorize(run.identity, signal), signal));
      signal.throwIfAborted();
      if (run.expires <= this.now() || !this.runs.has(token)) throw new Error("Read run expired");
      return value;
    };
    const overview = await timed("campaign-overview-source-hash-and-parse", async () => this.options.campaign?.overview(policyPrincipal) ?? {
      status: "unavailable",
      text: "",
      partyActorIds: [],
    });
    const partyIds = (
      Array.isArray(object(overview)["partyActorIds"])
        ? (object(overview)["partyActorIds"] as AiDmJsonValue[])
        : []
    ).filter((id): id is string => typeof id === "string");
    if (operation === "initial_context") {
      // A fresh, bounded world/user snapshot for every turn. No live document or
      // permission result survives a turn: missed hooks, reconnects and world
      // switches therefore cannot serve an old snapshot as current authority.
      const [worldValue, scenesValue, systemValue, combatsValue] = await Promise.all([
        call("foundry_get_world", {}), call("foundry_list_scenes", {}),
        call("foundry_get_system", {}), call("foundry_list_combats", {}),
      ]);
      await timed("authorization-between-read-phases", () => bounded(this.authorize(run.identity, signal), signal));
      signal.throwIfAborted();
      const world = object(worldValue);
      if (identifier(world["_id"] ?? world["id"]) !== run.identity.worldId) throw new Error("World changed");
      if (!Array.isArray(scenesValue) || !Array.isArray(combatsValue)) throw new Error("Invalid initial snapshot");
      const active = scenesValue.map(object).find((scene) => scene["active"] === true);
      const sceneId = active ? identifier(active["_id"] ?? active["id"]) : null;
      const scene = sceneId ? object(await call("foundry_get_scene", { id: sceneId })) : null;
      if (scene && (identifier(scene["_id"] ?? scene["id"]) !== sceneId || scene["active"] !== true)) throw new Error("Scene changed");
      const system = object(systemValue);
      const combat = combatsValue.map(object).find((value) => value["active"] === true && (!value["scene"] || value["scene"] === sceneId));
      const tokens = (scene && Array.isArray(scene["tokens"]) ? scene["tokens"] : []).slice(0, 40).map(object);
      const snapshot: RecordValue = {
        schemaVersion: 1, worldId: run.identity.worldId, campaignOverview: overview,
        world: { id: run.identity.worldId, title: name(world["title"]), system: name(world["system"]) },
        rulesSystem: { id: name(system["id"]), version: name(system["version"]), title: name(system["title"]) },
        scene: scene ? { id: sceneId, name: name(scene["name"]), active: true } : null,
        tokens: tokens.map((token) => ({ id: identifier(token["_id"] ?? token["id"]), name: name(token["name"]),
          actorId: typeof token["actorId"] === "string" ? token["actorId"] : null, hidden: token["hidden"] === true })),
        partyActorIds: partyIds,
        combat: combat ? { id: identifier(combat["_id"] ?? combat["id"]), round: combat["round"] ?? null, turn: combat["turn"] ?? null } : null,
        contextScope: "Fresh bounded GM snapshot; fetch actor state, scene detail and campaign excerpts on demand. GM-visible tokens are not player knowledge.",
      };
      await timed("authorization-final", () => bounded(this.authorize(run.identity, signal), signal));
      signal.throwIfAborted();
      if (run.expires <= this.now() || !this.runs.has(token)) throw new Error("Read run expired");
      return timed("serialization-and-budget-validation", async () => {
        const fitted = fitContext(snapshot);
        if (Buffer.byteLength(JSON.stringify(fitted)) > 24_000)
          throw new Error("Read result exceeds budget");
        return fitted;
      });
    }
    const party = async (sceneActors: string[]) => {
      const selected: AiDmJsonValue[] = [];
      const candidates: AiDmJsonValue[] = [];
      const issues: string[] = [];
      const ids = [...new Set(partyIds.length ? partyIds : sceneActors)].slice(0, 16);
      for (const id of ids) {
        const actor = object(await call("foundry_get_actor", { id }));
        if (identifier(actor["_id"] ?? actor["id"]) !== id) throw new Error("Party actor changed");
        const member = {
          id,
          name: name(actor["name"]),
          type: name(actor["type"]),
          state: actorState(actor),
        };
        if (
          partyIds.includes(id) ||
          (actor["type"] === "character" && actor["hasPlayerOwner"] === true)
        )
          selected.push(member);
        else if (actor["type"] === "character") candidates.push(member);
      }
      if (!partyIds.length)
        issues.push(
          "No explicit campaign party assignment; only live player-owned characters selected. Off-scene party may be missing.",
        );
      if (sceneActors.length > ids.length && !partyIds.length)
        issues.push("Scene actor inspection truncated");
      return {
        characters: selected,
        party: {
          status: partyIds.length ? "assigned" : selected.length ? "partial" : "unresolved",
          selection: partyIds.length
            ? "validated-campaign-references"
            : "live-player-owned-characters",
          members: selected,
          candidates,
          issues,
        },
      };
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
      if (operation === "context") {
        data["campaignOverview"] = overview;
        data["world"] = world
          ? { id: run.identity.worldId, title: name(world["title"]), system: name(world["system"]) }
          : { id: run.identity.worldId };
        Object.assign(data, await party([]));
        if (this.options.actions) data["nativeActions"] = this.options.actions.recent(principal);
        if (this.options.worldFiles) data["worldFileActions"] = this.options.worldFiles.recent(principal).slice(0, 6);
      }
      await bounded(this.authorize(run.identity, signal), signal);
      return operation === "context" ? fitContext(data) : data;
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
      if (!actors.includes(actorId) && !partyIds.includes(actorId))
        throw new Error("Actor is outside the current scene and assigned party");
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
        output["campaignOverview"] = overview;
        output["world"] = {
          id: run.identity.worldId,
          title: name(world?.["title"]),
          system: name(world?.["system"]),
        };
        Object.assign(output, await party(actors));
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
    if (operation === "context" && this.options.worldFiles)
      object(data)["worldFileActions"] = this.options.worldFiles.recent(principal).slice(0, 6);
    if (operation === "context") data = fitContext(object(data));
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
    let audit: Omit<ChatKitToolAuditEvent, "result" | "outcome"> | undefined;
    let auditedRunSignal: AbortSignal | undefined;
    const cancelled = () => abort.signal.aborted || auditedRunSignal?.aborted === true;
    const observe = (outcome: ChatKitToolAuditEvent["outcome"], result?: unknown) => {
      if (!audit) return;
      try {
        this.options.toolAudit?.({ ...audit, outcome, result });
      } catch {
        /* Evidence failure never redispatches an effect. */
      }
    };
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
      const token = request.get("x-chatkit-read-run") ?? "";
      const run = this.runs.get(token);
      // Record only scopes bound to a genuine server-issued run; browser headers
      // and failed internal authentication cannot invent an audit principal.
      if (
        run &&
        run.identity.worldId === principal.worldId &&
        run.identity.userId === principal.userId &&
        (!run.threadId || run.threadId === principal.threadId)
      ) {
        auditedRunSignal = run.signal;
        audit = {
          ...principal,
          runCorrelation: createHash("sha256").update(token).digest("hex"),
          operation: typeof body["operation"] === "string" ? body["operation"] : "",
          arguments: body["arguments"] ?? {},
        };
      }
      observe("attempt");
      const result = await withLatencyTrace(run?.traceId, () => latencySpan("adapter:operation", () => this.execute(
        request.get("x-chatkit-read-run") ?? "",
        principal,
        typeof body["operation"] === "string" ? body["operation"] : "",
        body["arguments"] ?? {},
        abort.signal,
      )));
      observe(cancelled() ? "cancelled" : "returned", result);
      if (!abort.signal.aborted) response.json({ ok: true, result });
    } catch {
      observe(cancelled() ? "cancelled" : "error");
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


