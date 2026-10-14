import { fileURLToPath } from "node:url";
import type { LegacyDeliveryContext } from "./api-contract.js";
import { AiGmDeliveryService, UnavailableHostWakeAdapter, type HostWakeAdapter } from "./ai-gm-delivery.js";
import { aiGmDeliveryEndpointDescriptors, configureAiGmDelivery } from "./endpoints.js";
import { MovementGenerationRolloverService } from "./movement-generation-rollover.js";
import { configureMovementGenerationRollover, rolloverEndpointDescriptors } from "./rollover-endpoint.js";

/** AI-owned adoption of the established queue; no live file relocation or identity reset. */
export function registerLegacyDelivery(context: LegacyDeliveryContext, adapter: HostWakeAdapter = new UnavailableHostWakeAdapter(
  "This process has no configured mechanism that can invoke or wake the active Codex AI-GM without a human turn.",
)): void {
  const path = fileURLToPath(new URL("ai-gm-deliveries.json", context.runtimeRoot));
  let service = new AiGmDeliveryService(path, "codex-active-ai-gm");
  const createError: LegacyDeliveryContext["createProtocolError"] = body => context.createProtocolError(body);
  const reconcile = () => {
    const store = context.movement.getStore();
    if (!store) return;
    service.initializeReconciliationWatermark(store, 1);
    service.reconcileMovementStore(store);
  };
  // Keep diagnostics available across an explicitly unreconciled generation.
  try { reconcile(); } catch { /* Persisted progress remains inspectable; no implicit repair. */ }
  configureAiGmDelivery(service, adapter, createError);
  const recovery = new MovementGenerationRolloverService(context.movement.path, path, service.consumerId, Date.now, () => context.movement.diagnose());
  configureMovementGenerationRollover(input => {
    const result = recovery.rollover(input);
    context.movement.reloadStore();
    service = new AiGmDeliveryService(path, "codex-active-ai-gm");
    configureAiGmDelivery(service, adapter, createError);
    return result;
  }, createError);
  const stopRecords = context.movement.onRecord(() => {
    try { reconcile(); } catch { /* Expose the durable stale watermark instead of losing the generic event. */ }
  });
  const stopEndpoints = context.registerEndpoints([...aiGmDeliveryEndpointDescriptors, ...rolloverEndpointDescriptors]);
  let running: Promise<unknown> | undefined;
  // An unavailable adapter cannot wake anybody. Do not manufacture automatic retry attempts.
  const worker = adapter.capability === "unavailable" ? undefined : setInterval(() => {
    if (!running) running = service.dispatchDue(adapter).catch(() => undefined).finally(() => { running = undefined; });
  }, 1_000);
  worker?.unref();
  context.onShutdown(async () => {
    if (worker) clearInterval(worker);
    stopRecords(); stopEndpoints();
    await running;
    configureAiGmDelivery(undefined, undefined);
    configureMovementGenerationRollover(undefined);
  });
}
