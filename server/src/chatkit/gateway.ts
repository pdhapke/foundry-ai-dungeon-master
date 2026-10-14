import { PreparationPrivacyError } from "../campaign-privacy.js";
import type { AcceptanceFixture } from "../config.js";
import type { RequestHandler } from "express";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";
import { TurnConflict, type ChatKitTurns, type ChatKitTurnLease } from "./turns.js";
import { bounded } from "./read-tools.js";
import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { supportedChatKitOperation } from "@foundry-ai-dungeon-master/shared";
import { explicitPauseRequest, explicitSessionRequest, type SessionRequestAuthorization } from "./pause-request.js";
import { randomUUID } from "node:crypto";
import { explicitWorldRequest } from "./world-request.js";
import { routineCompletion } from "./routine-completion.js";
import { narrationCompletion } from "./narration-request.js";
import type { AiDmMutationBoundaryAcknowledgement } from "@foundry-ai-dungeon-master/shared";
import { currentTraceId, latencyEvent, validTraceId, withLatencyTrace } from "../latency-trace.js";
import { PreparationRequestError, preparationErrorCode, preparationPhaseEvent, preparationResultEffects, preparationFailureResponse } from '../preparation/outcome.js';

const diagnostics = {
  requests: 0,
  stage: "idle",
  errorCode: null as string | null,
  upstreamStatus: null as number | null,
};
export function chatKitDiagnostics(): Readonly<typeof diagnostics> {
  return { ...diagnostics };
}
function stage(value: string, errorCode: string | null = null): void {
  diagnostics.stage = value;
  diagnostics.errorCode = errorCode;
}

export interface ChatKitGatewayOptions {
  allowMutationBoundary?: boolean;
  acceptanceFixtures?: Readonly<Record<string, AcceptanceFixture>>;
  turns?: ChatKitTurns;
  sidecarUrl: string;
  internalSecret: string;
  allowedOrigins: readonly string[];
  authenticate(input: {
    sessionCredential: string;
    clientId: string;
    moduleVersion: string;
    browserSessionId: string;
  }): Promise<AiDmAuthenticatedIdentity> | AiDmAuthenticatedIdentity;
  authorize(identity: AiDmAuthenticatedIdentity, signal?: AbortSignal): Promise<void>;
  resolveAuthorization(
    identity: AiDmAuthenticatedIdentity,
  ): Promise<{ apiKey: string; model: string }>;
  prepareContext?(identity: AiDmAuthenticatedIdentity, signal: AbortSignal): Promise<Record<string, unknown>>;
  invalidatePreparation?(identity: AiDmAuthenticatedIdentity, reason: string): void;
  credentialExpiry?(identity: AiDmAuthenticatedIdentity): string | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  runTimeoutMs?: number;
  nativeActions?(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    signal: AbortSignal,
  ): Promise<AiDmJsonValue>;
  /** Deterministic private preparation; never resolves provider credentials or runs inference. */
  preparationAction?(identity: AiDmAuthenticatedIdentity, body: unknown, signal: AbortSignal): Promise<AiDmJsonValue>;
  beginReadRun?(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    signal: AbortSignal,
    pauseRequest?: SessionRequestAuthorization,
    traceId?: string,
    releaseMutationSlot?: (boundary: AiDmMutationBoundaryAcknowledgement) => void,
  ): { token: string; release(): void };
}

/** Authentication and transparent ChatKit transport; model credentials never reach the browser. */
export function createChatKitGateway(options: ChatKitGatewayOptions): RequestHandler {
  const endpoint = new URL("/chatkit", options.sidecarUrl);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    !options.internalSecret
  ) {
    throw new Error("ChatKit sidecar requires authenticated loopback HTTP.");
  }
  const preparations = new Map<string, Promise<{ model: string; context: Record<string, unknown> }>>();
  const failures = new Map<string, number>();
  const keyFor = (identity: AiDmAuthenticatedIdentity) => JSON.stringify([identity.worldId, identity.userId, identity.clientId]);
  const prepare = (identity: AiDmAuthenticatedIdentity, signal: AbortSignal) => {
    const key = keyFor(identity);
    let work = preparations.get(key);
    if (!work) {
      if ((failures.get(key) ?? 0) > Date.now()) throw new Error("Preparation retry backoff");
      // Shared operation is bounded independently; cancelling one waiter must not cancel another command.
      const boundedSignal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
      work = Promise.all([bounded(options.resolveAuthorization(identity), boundedSignal), options.prepareContext?.(identity, boundedSignal) ?? Promise.resolve({ status: "not-configured" })])
        .then(([credentials, context]) => ({ model: credentials.model, context }))
        .catch(error => { if (failures.size >= 64) failures.clear(); failures.set(key, Date.now() + 2_000); throw error; })
        .finally(() => preparations.delete(key));
      preparations.set(key, work);
    }
    return bounded(work, signal);
  };
  return (request, response) => withLatencyTrace(validTraceId(request.get("x-ai-dm-trace")) ? request.get("x-ai-dm-trace") : randomUUID(), async () => {
    const arrived = performance.now();
    const requestArrivedAtMs = Date.now();
    const traceId = currentTraceId()!;
    const trace = (event: string, fields: Record<string, unknown> = {}) => { latencyEvent(event, typeof fields["durationMs"] === "number" ? fields["durationMs"] : typeof fields["queueWaitMs"] === "number" ? fields["queueWaitMs"] : undefined); console.info(JSON.stringify({
      type: "pause-timing", traceId, stage: event, atMs: Date.now(), requestArrivedAtMs, elapsedMs: performance.now() - arrived, ...fields })); };
    trace("request-arrival");
    diagnostics.requests = Math.min(diagnostics.requests + 1, Number.MAX_SAFE_INTEGER);
    diagnostics.upstreamStatus = null;
    stage("received");
    if (request.get("x-chatkit-acceptance-fixture")) {
      response.status(403).json({ error: "Acceptance budgets are server-owned." }); return;
    }
    const origin = request.get("origin");
    if (origin && !options.allowedOrigins.includes(origin)) {
      stage("rejected", "ORIGIN_FORBIDDEN");
      response.status(403).json({ error: "Foundry origin is not allowed." });
      return;
    }
    if (origin) response.set({ "Access-Control-Allow-Origin": origin, Vary: "Origin" });
    response.set("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      stage("preflight");
      response.set({
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "content-type, chatkit-frame-instance-id, x-ai-dm-session, x-ai-dm-client, x-ai-dm-version, x-ai-dm-browser-session, x-ai-dm-event, x-ai-dm-trace",
      });
      response.status(204).end();
      return;
    }
    let identity: AiDmAuthenticatedIdentity;
    try {
      identity = await options.authenticate({
        sessionCredential: request.get("x-ai-dm-session") ?? "",
        clientId: request.get("x-ai-dm-client") ?? "",
        moduleVersion: request.get("x-ai-dm-version") ?? "",
        browserSessionId: request.get("x-ai-dm-browser-session") ?? "",
      });
    } catch {
      stage("rejected", "SESSION_INVALID");
      response.status(401).json({ error: "Foundry session expired. Reconnect the companion." });
      return;
    }
    if (!identity.isGm) {
      stage("rejected", "GM_REQUIRED");
      response.status(403).json({ error: "ChatKit is available to GMs only." });
      return;
    }
    const abort = new AbortController();
    const disconnected = () => {
      if (!response.writableEnded) {
        abort.abort();
        options.invalidatePreparation?.(identity, "request-disconnected");
      }
    };
    request.on("aborted", disconnected);
    response.on("close", disconnected);
    try {
      stage("verifying-current-gm");
      await bounded(
        options.authorize(identity, abort.signal),
        AbortSignal.any([abort.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]),
      );
      trace("initial-authorization-finished");
      if(request.path.endsWith("/preparation"))preparationPhaseEvent("gateway-initial-authorization","returned");
    } catch(error) {
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      if (response.destroyed) {
        stage("cancelled");
        return;
      }
      if(request.path.endsWith('/preparation')) {
        preparationPhaseEvent('gateway-initial-authorization','error',error);
        const reply=preparationFailureResponse(new PreparationRequestError('gateway-initial-authorization','none',preparationErrorCode(error)));
        stage('rejected','CURRENT_GM_UNVERIFIED');response.status(reply.status).json(reply.body);return;
      }
      stage("rejected", "CURRENT_GM_UNVERIFIED");
      response
        .status(403)
        .json({ error: "Current Foundry GM authorization could not be verified." });
      return;
    }
    if (abort.signal.aborted) return;
    const pinnedFixture = Object.entries(options.acceptanceFixtures ?? {}).find(([, fixture]) => fixture.traceId === traceId);
    const requestThread = (request.body as { params?: { thread_id?: unknown } } | null)?.params?.thread_id;
    if (pinnedFixture && (pinnedFixture[1].worldId !== identity.worldId || pinnedFixture[1].userId !== identity.userId || pinnedFixture[1].threadId !== requestThread || Date.parse(pinnedFixture[1].expiresAt) <= Date.now())) {
      request.off("aborted", disconnected); response.off("close", disconnected);
      response.status(403).json({ error: "Acceptance fixture scope or expiry mismatch." }); return;
    }
    let finishTurn: ChatKitTurnLease | undefined;
    let readRun: { token: string; release(): void } | undefined;
    const runTimeout = setTimeout(() => abort.abort(), options.runTimeoutMs ?? 300_000);
    try {
      if (request.path.endsWith("/preparation")) {
        if (!options.preparationAction) throw new Error("Preparation workflow unavailable");
        const result = await bounded(options.preparationAction(identity, request.body, abort.signal), abort.signal);
        stage('preparation-final-authorization');
        try {
          await bounded(options.authorize(identity, abort.signal), abort.signal);
          abort.signal.throwIfAborted();preparationPhaseEvent('gateway-final-authorization','returned');
        } catch(error) {
          preparationPhaseEvent('gateway-final-authorization','error',error);
          throw new PreparationRequestError('gateway-final-authorization',preparationResultEffects(result),preparationErrorCode(error));
        }
        stage('preparation-completed');
        response.json(result);
        return;
      }
      if (request.path.endsWith("/prepare")) {
        const started = performance.now();
        try {
          const prepared = await prepare(identity, abort.signal);
          let admission: Record<string, unknown>;
          try {
            const admissionSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
            const admissionResponse = await bounded((options.fetch ?? globalThis.fetch)(new URL("/context-admission", endpoint), {
              method: "POST", signal: admissionSignal,
              headers: { "content-type": "application/json", "x-chatkit-secret": options.internalSecret,
                "x-chatkit-principal": Buffer.from(JSON.stringify({ worldId: identity.worldId, userId: identity.userId, isGm: true })).toString("base64") },
              body: JSON.stringify({ model: prepared.model }),
            }), admissionSignal);
            const raw: unknown = await bounded(admissionResponse.json(), admissionSignal);
            if (!admissionResponse.ok || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid context admission");
            admission = raw as Record<string, unknown>;
            if (admission["admissible"] !== true || !["permanentTokenUpperBound", "inputCeiling", "reservedToolsAndOutput", "remainingInputUnits"].every(key => Number.isSafeInteger(admission[key]) && Number(admission[key]) >= 0) || Number(admission["reservedToolsAndOutput"]) < 8192 || Number(admission["remainingInputUnits"]) < 4096 || Number(admission["inputCeiling"]) < Number(admission["permanentTokenUpperBound"]) + Number(admission["remainingInputUnits"])) throw new Error("Context budget requires action");
          } catch {
            response.status(503).json({ state: "reconnect-required", reason: "context-action-required", error: "Context action required. The selected model's permanent instructions, tool schemas and minimum request headroom could not be admitted. Check sidecar availability and repair the selected model context configuration before retrying. No inference was sent.", retryAfterMs: 2000 });
            trace("preparation-context-admission-failed", { durationMs: performance.now() - started });
            return;
          }
          await bounded(options.authorize(identity, abort.signal), abort.signal);
          const expiry = options.credentialExpiry?.(identity) ?? null;
          const validUntil = Math.min(Date.now() + 30_000, expiry ? Date.parse(expiry) - 60_000 : Infinity);
          response.json({ state: "ready", preparedAt: new Date().toISOString(), validUntil: new Date(validUntil).toISOString(), credentials: { model: prepared.model, expiresAt: expiry }, context: prepared.context, contextAdmission: { admissible: true, permanentTokenUpperBound: admission["permanentTokenUpperBound"], inputCeiling: admission["inputCeiling"], reservedToolsAndOutput: admission["reservedToolsAndOutput"], remainingInputUnits: admission["remainingInputUnits"] },
            meaning: "Current GM authorization, preparation prerequisites and minimum context headroom checked; full conversation admission and execution remain authoritative." });
          trace("preparation-finished", { durationMs: performance.now() - started });
        } catch (error) {
          const privacy = error instanceof PreparationPrivacyError;
          if (!response.destroyed) response.status(503).json({ state: "reconnect-required", error: privacy ? "Privacy action required. Resolve the identified storage blockers before readiness; public scene assets need a separate disclosure audit." : "Preparation unavailable. Reconnect or retry after checking authorization.", ...(privacy ? { reason: "privacy-action-required", blockers: error.blockers } : {}), retryAfterMs: 2000 });
          trace("preparation-failed", { durationMs: performance.now() - started });
        }
        return;
      }
      if (request.path.endsWith("/actions")) {
        if (!options.nativeActions) throw new Error("Native actions unavailable");
        if (
          request.body &&
          typeof request.body === "object" &&
          (["core", "core-move-batch", "attack"].includes(String((request.body as { kind?: unknown }).kind)) ||
          ((request.body as { kind?: unknown; decision?: unknown }).kind === "campaign" &&
          (request.body as { decision?: unknown }).decision !== undefined))
        ) {
          const actionQueuedAt = performance.now();
          finishTurn = await options.turns?.enterAction(identity, request.body, abort.signal);
          trace("direct-queue-entered", { queueWaitMs: performance.now() - actionQueuedAt });
          await bounded(options.authorize(identity, abort.signal), abort.signal);
        }
        const actionStartedAt = performance.now();
        const result = await options.nativeActions(identity, request.body, abort.signal);
        trace("direct-action-result", { durationMs: performance.now() - actionStartedAt });
        response.json({
          ok: true,
          result,
        });
        trace("direct-response-written");
        return;
      }
      if (
        !request.path.endsWith("/thread") &&
        !supportedChatKitOperation((request.body as { type?: unknown } | null)?.type)
      ) {
        response.status(400).json({ error: "Unsupported ChatKit operation." });
        return;
      }
      const pauseControlOnly = Boolean(explicitPauseRequest(request.body));
      const completion = routineCompletion(request.body);
      const narration = options.allowMutationBoundary ? narrationCompletion(request.body) : undefined;
      const coreControlOnly = Boolean(explicitSessionRequest(request.body)?.session && !["chat.post", "playlist.sound"].includes(explicitSessionRequest(request.body)!.session!.kind));
      const queuedAt = performance.now();
      // Preserve shared world ordering until live queue evidence justifies a separate control lane.
      finishTurn = await options.turns?.enter(
        identity,
        request.body,
        abort.signal,
        request.get("x-ai-dm-event"),
      );
      trace("queue-entered", { queueWaitMs: performance.now() - queuedAt, pauseControlOnly });
      const queuedAuthorizationAt = performance.now();
      await bounded(options.authorize(identity, abort.signal), abort.signal);
      trace("queued-authorization-finished", { durationMs: performance.now() - queuedAuthorizationAt });
      stage("resolving-authorization");
      // This explicit action is deterministic and must work without model credentials.
      // Python independently validates the payload and isolates its player-safe thread.
      const playerObservationOnly = (request.body as { type?: unknown; params?: { action?: { type?: unknown } } } | null)?.type === "threads.custom_action" &&
        (request.body as { params?: { action?: { type?: unknown } } }).params?.action?.type === "foundry.player-observation";
      const activePreparation = preparations.get(keyFor(identity));
      if (activePreparation) await bounded(activePreparation, abort.signal);
      const credentialsStarted = performance.now();
      const credentials = playerObservationOnly || request.path.endsWith("/thread") ? { apiKey: "", model: "" } :
        await bounded(options.resolveAuthorization(identity), abort.signal);
      trace("credentials-resolved", { model: credentials.model, durationMs: performance.now() - credentialsStarted });
      if (!request.path.endsWith("/thread")) {
        const sessionRequest = explicitSessionRequest(request.body);
        const worldControl = explicitWorldRequest(request.body);
        readRun = options.beginReadRun?.(
          identity,
          request.body,
          abort.signal,
          sessionRequest || worldControl
            ? { ...sessionRequest, ...(worldControl ? { worldControl } : {}) }
            : undefined,
          traceId,
          narration && finishTurn ? (boundary) => {
            if (!finishTurn?.releaseForNarration) throw new Error("Authoritative queue boundary unavailable");
            finishTurn.releaseForNarration(boundary);
            trace("world-slot-released-for-narration");
          } : undefined,
        );
      }
      stage("proxying");
      const upstreamEndpoint = request.path.endsWith("/thread")
        ? new URL("/chatkit/thread", endpoint)
        : endpoint;
      const threadId = (request.body as { params?: { thread_id?: unknown } } | null)?.params?.thread_id;
      const acceptance = Object.entries(options.acceptanceFixtures ?? {}).find(([, fixture]) => fixture.worldId === identity.worldId && fixture.userId === identity.userId && fixture.threadId === threadId && fixture.traceId === traceId && Date.parse(fixture.expiresAt) > Date.now());
      const headerTimeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 15_000);
      let upstream: Response;
      try {
        upstream = await bounded(
          (options.fetch ?? globalThis.fetch)(upstreamEndpoint, {
            method: "POST",
            signal: abort.signal,
            headers: {
              "content-type": "application/json",
              "x-chatkit-secret": options.internalSecret,
              "x-chatkit-principal": Buffer.from(
                JSON.stringify({ worldId: identity.worldId, userId: identity.userId, isGm: true }),
              ).toString("base64"),
              "x-chatkit-api-key": credentials.apiKey,
              "x-chatkit-model": credentials.model,
              "x-chatkit-trace": traceId,
              ...(acceptance ? { "x-chatkit-acceptance-fixture": acceptance[0] } : {}),
              "x-chatkit-pause-control": String(pauseControlOnly),
              "x-chatkit-core-control": String(coreControlOnly),
              ...(completion ? { "x-chatkit-completion": Buffer.from(JSON.stringify(completion)).toString("base64") } : {}),
              ...(narration ? { "x-chatkit-narration-contract": Buffer.from(JSON.stringify(narration)).toString("base64") } : {}),
              ...(readRun ? { "x-chatkit-read-run": readRun.token } : {}),
            },
            body: JSON.stringify(request.body),
          }),
          abort.signal,
        );
      } finally {
        clearTimeout(headerTimeout);
      }
      response.status(upstream.status);
      diagnostics.upstreamStatus = upstream.status;
      stage("upstream-response", upstream.ok ? null : "SIDECAR_REJECTED");
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      response.set("Content-Type", contentType);
      if (!upstream.body) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      let firstChunk = true;
      try {
        while (!abort.signal.aborted) {
          const chunk = (await bounded(reader.read(), abort.signal)) as {
            done: boolean;
            value?: Uint8Array;
          };
          const { done, value } = chunk;
          if (done) break;
          if (!value) continue;
          const authAt = performance.now();
          await bounded(
            options.authorize(identity, abort.signal),
            AbortSignal.any([abort.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]),
          );
          trace("stream-authorization", { durationMs: performance.now() - authAt });
          if (firstChunk) { trace("first-visible-stream-chunk"); firstChunk = false; }
          if (!response.write(Buffer.from(value)))
            await new Promise<void>((resolve) => {
              const finish = () => {
                response.off("drain", finish);
                response.off("close", finish);
                abort.signal.removeEventListener("abort", finish);
                resolve();
              };
              response.once("drain", finish);
              response.once("close", finish);
              abort.signal.addEventListener("abort", finish, { once: true });
              if (abort.signal.aborted) finish();
            });
        }
      } finally {
        await bounded(reader.cancel(), AbortSignal.timeout(1000)).catch(() => {});
      }
      response.end();
      trace("final-response-finished");
      if (upstream.ok) stage("completed");
    } catch (error) {
      if(request.path.endsWith('/preparation')) {
        const failure=error instanceof PreparationRequestError?error:new PreparationRequestError('operation','unknown',preparationErrorCode(error));
        const reply=preparationFailureResponse(failure);
        stage('preparation-status-required',reply.body.code);
        if(!response.destroyed&&!response.headersSent)response.status(reply.status).json(reply.body);
        return;
      }
      if (error instanceof TurnConflict) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (abort.signal.aborted) {
        if (!response.destroyed && !response.headersSent) {
          stage("failed", "SIDECAR_TIMEOUT");
          response.status(504).json({ error: "ChatKit service did not respond in time." });
        } else {
          stage("cancelled");
          if (!response.destroyed && !response.writableEnded) response.end();
        }
        return;
      }
      stage(
        "failed",
        diagnostics.stage === "resolving-authorization"
          ? "OPENAI_AUTH_UNAVAILABLE"
          : "SIDECAR_UNAVAILABLE",
      );
      if (!response.headersSent)
        response
          .status(503)
          .json({ error: "ChatKit service or authorized OpenAI credentials are unavailable." });
      else response.end();
    } finally {
      trace("queue-exit");
      finishTurn?.();
      readRun?.release();
      clearTimeout(runTimeout);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
    }
  });
}

