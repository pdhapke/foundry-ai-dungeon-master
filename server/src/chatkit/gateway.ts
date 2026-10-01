import type { RequestHandler } from "express";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";
import { bounded } from "./read-tools.js";

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
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  runTimeoutMs?: number;
  beginReadRun?(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    signal: AbortSignal,
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
  return async (request, response) => {
    diagnostics.requests = Math.min(diagnostics.requests + 1, Number.MAX_SAFE_INTEGER);
    diagnostics.upstreamStatus = null;
    stage("received");
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
          "content-type, chatkit-frame-instance-id, x-ai-dm-session, x-ai-dm-client, x-ai-dm-version, x-ai-dm-browser-session",
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
      if (!response.writableEnded) abort.abort();
    };
    request.on("aborted", disconnected);
    response.on("close", disconnected);
    try {
      stage("verifying-current-gm");
      await bounded(
        options.authorize(identity, abort.signal),
        AbortSignal.any([abort.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]),
      );
    } catch {
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      if (response.destroyed) {
        stage("cancelled");
        return;
      }
      stage("rejected", "CURRENT_GM_UNVERIFIED");
      response
        .status(403)
        .json({ error: "Current Foundry GM authorization could not be verified." });
      return;
    }
    if (abort.signal.aborted) return;
    let readRun: { token: string; release(): void } | undefined;
    const runTimeout = setTimeout(() => abort.abort(), options.runTimeoutMs ?? 300_000);
    try {
      stage("resolving-authorization");
      const credentials = await bounded(options.resolveAuthorization(identity), abort.signal);
      if (!request.path.endsWith("/thread"))
        readRun = options.beginReadRun?.(identity, request.body, abort.signal);
      stage("proxying");
      const upstreamEndpoint = request.path.endsWith("/thread")
        ? new URL("/chatkit/thread", endpoint)
        : endpoint;
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
      try {
        while (!abort.signal.aborted) {
          const chunk = (await bounded(reader.read(), abort.signal)) as {
            done: boolean;
            value?: Uint8Array;
          };
          const { done, value } = chunk;
          if (done) break;
          if (!value) continue;
          await bounded(
            options.authorize(identity, abort.signal),
            AbortSignal.any([abort.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]),
          );
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
      if (upstream.ok) stage("completed");
    } catch {
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
      readRun?.release();
      clearTimeout(runTimeout);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
    }
  };
}
