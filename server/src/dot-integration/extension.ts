import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { mountMcpEvents } from "../../../../foundry-local-api/server/events-core.js";
import type { ApiExtensionContext } from "./api-contract.js";
import { DotIntegration, type DotIntegrationSetup } from "./runtime.js";
import { DOT_EVENT_NAME } from "./contract.js";
import { loadDotProductionSetup } from "./production.js";
import { TunnelSetupService, TUNNEL_SETUP_EVENT } from "./tunnel-setup.js";
import { ProtectedTunnelConfigurationStorage, TunnelConfigurationService, TUNNEL_CONFIGURATION_KIND, tunnelControllerSchema } from "./tunnel-configuration.js";
import { TunnelLifecycle, TunnelActivationFailure } from "./tunnel-lifecycle.js";
import { WindowsTunnelHost } from "./tunnel-host.js";
import { ProtectedTunnelDiagnostics } from "./tunnel-diagnostics.js";
import { AdoptingTunnelToolInstaller } from "./tool-adoption.js";

/** Trusted AI-owned extension; loading registers interfaces but never launches a tunnel. */
export function registerExtension(context: ApiExtensionContext): void {
  if (context.version !== 1) throw new Error("Unsupported generic API extension contract.");
  const ownedRoot = new URL("../../../", import.meta.url);
  const installer = new AdoptingTunnelToolInstaller(
    fileURLToPath(new URL(".runtime/tools/openai-tunnel-client/", ownedRoot)),
    fileURLToPath(new URL("tools/openai-tunnel-client/", context.runtimeRoot)),
  );
  const tools = new TunnelSetupService(installer, context.bridge);
  const productionDependencies = { gateway: context.bridge, bindHost: context.bindHost, administrativeCredentialSha256: context.administrativeCredentialSha256 };
  const createDot = (setup: DotIntegrationSetup): DotIntegration => new DotIntegration(setup, {
    client: () => context.bridge.getClient({ clientId: setup.controller.clientId, userId: setup.controller.userId, lane: "gm" }),
    call: async (command, payload, signal) => {
      signal?.throwIfAborted();
      const cancellationId = (payload as { cancellationId?: string } | undefined)?.cancellationId;
      const cancel = () => {
        if (command === "dotRespond" && cancellationId) context.bridge.send(JSON.stringify({ kind: "dot-cancel-response", clientId: setup.controller.clientId, cancellationId }), { clientId: setup.controller.clientId, lane: "gm" });
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try { return await context.call(command, payload, { clientId: setup.controller.clientId, userId: setup.controller.userId, lane: "gm" }); }
      finally { signal?.removeEventListener("abort", cancel); }
    },
    receipt: (clientId, eventId, accepted) => { context.bridge.send(JSON.stringify({ kind: "dot-receipt", clientId, eventId, accepted }), { clientId, lane: "gm" }); },
  });
  const loaded = loadDotProductionSetup(process.env["FOUNDRY_DOT_CONFIG"], productionDependencies);
  let dot = loaded ? createDot(loaded) : undefined;
  const externallyLoaded = dot !== undefined;
  const storage = new ProtectedTunnelConfigurationStorage();
  const readiness = z.object({ controller: tunnelControllerSchema, automaticEventsEnabled: z.boolean(), dmEventMode: z.enum(["dot", "embedded"]) }).strict();
  const lifecycle = new TunnelLifecycle({
    prepare: async (controller, purpose) => {
      if (externallyLoaded) throw new TunnelActivationFailure("activation_loaded");
      const scope = readiness.parse(await context.call("dotSetupReadiness", {}, { clientId: controller.clientId, userId: controller.userId, lane: "gm" }));
      if (controller.worldId !== "mcp-test" || JSON.stringify(scope.controller) !== JSON.stringify(controller)) throw new TunnelActivationFailure("controller_mismatch");
      if (!scope.automaticEventsEnabled || scope.dmEventMode !== "dot") throw new TunnelActivationFailure("dot_mode_required");
      const profile = storage.activationProfile(controller), executable = purpose === "display" ? installer.displayExecutablePath() : installer.verifiedExecutablePath();
      const setup = loadDotProductionSetup(join(storage.root, "dot-config.json"), productionDependencies);
      if (!setup || JSON.stringify(setup.controller) !== JSON.stringify(controller)) throw new TunnelActivationFailure("controller_mismatch");
      return { controller, profile, executable, setup };
    }, create: createDot,
    diagnostics: new ProtectedTunnelDiagnostics(storage.root),
    host: observer => new WindowsTunnelHost(fileURLToPath(new URL("scripts/foundry-dot-tunnel-host.ps1", ownedRoot)), undefined, undefined, observer),
    publish: runtime => { if (!externallyLoaded) dot = runtime; },
  });
  const configuration = new TunnelConfigurationService(storage, context.bridge,
    sender => context.call("dotSetupScope", {}, { clientId: sender.clientId, userId: sender.userId, lane: "gm" }), "mcp-test", () => dot !== undefined, lifecycle);
  context.registerPrivateChannel(TUNNEL_CONFIGURATION_KIND, (payload, sender, current) => configuration.handle(payload, sender, current));
  context.onConnectionEstablished(client => {
    const current = dot;
    if (current && client.clientId === current.binding.clientId) void current.bind().catch(() => current.disconnected());
  });
  context.onConnectionLost(client => {
    tools.disconnected(client.clientId); lifecycle.disconnected(client.clientId);
    if (dot && client.clientId === dot.binding.clientId) dot.disconnected();
  });
  context.registerEventHandler(TUNNEL_SETUP_EVENT, (payload, metadata) => tools.handle(payload, metadata));
  context.registerEventHandler("foundry.dot_controller_requested", (_payload, metadata) => {
    const current = dot;
    if (current && metadata.clientId === current.binding.clientId && metadata.userId === current.binding.userId && metadata.lane === "gm") void current.bind().catch(() => current.disconnected());
  });
  context.registerEventHandler(DOT_EVENT_NAME, (payload, metadata) => dot?.ingress(payload, metadata));
  const route = express();
  route.disable("x-powered-by");
  mountMcpEvents(route, "/dot/mcp", () => dot?.httpOptions());
  route.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next; // Express requires four parameters for an error middleware.
    response.setHeader("Cache-Control", "no-store"); response.status(400).json({ error: "Invalid scoped MCP request." });
  });
  // The unchanged route adopts existing protected profiles without rewriting keys.
  context.registerRoute("/dot/mcp", route);
  context.onShutdown(async () => {
    tools.stop();
    if (externallyLoaded) await dot?.stop(); else await lifecycle.shutdown();
  });
  dot?.start();
}
