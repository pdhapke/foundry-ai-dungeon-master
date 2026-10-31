import { fileURLToPath } from "node:url";
import type { LegacyDeliveryContext } from "./api-contract.js";
import { AiGmDeliveryService, type HostWakeAdapter } from "./ai-gm-delivery.js";
import { aiGmDeliveryEndpointDescriptors, configureAiGmDelivery } from "./endpoints.js";
import { MovementGenerationRolloverService } from "./movement-generation-rollover.js";
import {
  configureMovementGenerationRollover,
  rolloverEndpointDescriptors,
} from "./rollover-endpoint.js";
import type { WakeWebhookConfig } from "./wake-webhook-config.js";
import {
  AuxiliaryWakeQueue,
  chatWakeFromHook,
  combatWakeFromEvent,
  createBridgeEnricher,
  dispatchBatchedWake,
  selectWakeAdapter,
  type WakeEnricher,
  type WakeObserverMetadata,
} from "./wake-webhook.js";

type EventObserver = (payload: unknown, metadata: WakeObserverMetadata) => void | Promise<void>;

/** AI-owned adoption of the established queue; no live file relocation or identity reset. */
export function registerLegacyDelivery(
  context: LegacyDeliveryContext,
  adapter?: HostWakeAdapter,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const enrich = createBridgeEnricher({
    getClient: (selector) => context.bridge.getClient(selector),
    getVerifiedFoundryIdentity: (selector) => context.bridge.getVerifiedFoundryIdentity(selector),
    call: (command, payload, selector) => context.call(command, payload, selector),
  });
  const selected = selectWakeAdapter(environment, fetch, enrich);
  const resolved = adapter ?? selected.adapter;
  const wake = adapter || !selected.config.enabled ? undefined : selected.config;
  const path = fileURLToPath(new URL("ai-gm-deliveries.json", context.runtimeRoot));
  let service = new AiGmDeliveryService(path, "codex-active-ai-gm");
  const createError: LegacyDeliveryContext["createProtocolError"] = (body) =>
    context.createProtocolError(body);
  const reconcile = () => {
    const store = context.movement.getStore();
    if (!store) return;
    service.initializeReconciliationWatermark(store, 1);
    service.reconcileMovementStore(store);
  };
  // Keep diagnostics available across an explicitly unreconciled generation.
  try {
    reconcile();
  } catch {
    /* Persisted progress remains inspectable; no implicit repair. */
  }
  configureAiGmDelivery(service, resolved, createError);
  const recovery = new MovementGenerationRolloverService(
    context.movement.path,
    path,
    service.consumerId,
    Date.now,
    () => context.movement.diagnose(),
  );
  configureMovementGenerationRollover((input) => {
    const result = recovery.rollover(input);
    context.movement.reloadStore();
    service = new AiGmDeliveryService(path, "codex-active-ai-gm");
    configureAiGmDelivery(service, resolved, createError);
    return result;
  }, createError);
  const stopRecords = context.movement.onRecord(() => {
    try {
      reconcile();
    } catch {
      /* Expose the durable stale watermark instead of losing the generic event. */
    }
  });
  const stopEndpoints = context.registerEndpoints([
    ...aiGmDeliveryEndpointDescriptors,
    ...rolloverEndpointDescriptors,
  ]);
  const auxiliary = wake ? new AuxiliaryWakeQueue() : undefined;
  const observerStops = observeAuxiliaryEvents(context, wake, auxiliary);
  if (!adapter) reportWakeConfiguration(selected.config);
  let running: Promise<unknown> | undefined;
  // An unavailable adapter cannot wake anybody. Do not manufacture automatic retry attempts.
  const worker =
    resolved.capability === "unavailable"
      ? undefined
      : setInterval(() => {
          if (running) return;
          const job = wake
            ? deliverWake(service, wake, enrich, auxiliary)
            : service.dispatchDue(resolved);
          running = Promise.resolve(job)
            .catch(() => undefined)
            .finally(() => {
              running = undefined;
            });
        }, 1_000);
  worker?.unref();
  context.onShutdown(async () => {
    if (worker) clearInterval(worker);
    for (const stop of observerStops) stop();
    stopRecords();
    stopEndpoints();
    await running;
    configureAiGmDelivery(undefined, undefined);
    configureMovementGenerationRollover(undefined);
  });
}

async function deliverWake(
  service: AiGmDeliveryService,
  wake: WakeWebhookConfig,
  enrich: WakeEnricher,
  auxiliary: AuxiliaryWakeQueue | undefined,
): Promise<void> {
  // One webhook per quiet burst across movement, chat, and combat events.
  await dispatchBatchedWake(service, wake, fetch, enrich, auxiliary);
}

function observeAuxiliaryEvents(
  context: LegacyDeliveryContext,
  wake: WakeWebhookConfig | undefined,
  auxiliary: AuxiliaryWakeQueue | undefined,
): Array<() => void> {
  const observe = context.observeEvent?.bind(context) as
    | ((name: string, handler: EventObserver) => () => void)
    | undefined;
  if (!wake || !auxiliary || typeof observe !== "function") {
    if (wake && (wake.chat || wake.combatTurns) && typeof observe !== "function")
      console.error(
        "[foundry-ai-dungeon-master] Chat and combat wake events need a Local API build that exposes observeEvent. Movement delivery is unaffected.",
      );
    return [];
  }
  const stops: Array<() => void> = [];
  if (wake.chat)
    stops.push(
      observe("createChatMessage", async (payload, metadata) => {
        const receivedAt = Date.now();
        const parsed = chatWakeFromHook(payload, metadata, receivedAt, wake.playersOnly);
        if (!parsed) return;
        // Another GM account (or the AI posting as one) must not wake the AI-GM.
        if (wake.playersOnly && parsed.userId && (await isGameMaster(context, parsed.userId)))
          return;
        auxiliary.push(parsed, receivedAt);
      }),
    );
  if (wake.combatTurns)
    stops.push(
      observe("foundry-local-api.combat-turn", (payload, metadata) => {
        const parsed = combatWakeFromEvent(payload, metadata, Date.now());
        if (parsed) auxiliary.push(parsed, Date.now());
      }),
    );
  return stops;
}

/** Assistant GM (3) and Gamemaster (4) roles. Unknown users count as players. */
async function isGameMaster(context: LegacyDeliveryContext, userId: string): Promise<boolean> {
  try {
    const user = (await context.call("userGet", { userId }, { lane: "gm" })) as {
      role?: unknown;
    } | null;
    return typeof user?.role === "number" && user.role >= 3;
  } catch {
    return false;
  }
}

function reportWakeConfiguration(config: WakeWebhookConfig): void {
  if (config.enabled) {
    let origin = "configured endpoint";
    try {
      origin = new URL(config.url ?? "").origin;
    } catch {
      /* Enabled configuration already rejected credential-bearing URLs. */
    }
    console.error(
      `[foundry-ai-dungeon-master] AI-GM wake webhook enabled for ${origin}. Quiet period ${config.debounceMs}ms, max wait ${config.maxWaitMs}ms. Player moves only: ${config.playersOnly}. Room crossings only: ${config.roomCrossingsOnly}. Chat: ${config.chat}. Combat turns: ${config.combatTurns}.`,
    );
    return;
  }
  if (config.problem)
    console.error(`[foundry-ai-dungeon-master] AI-GM wake webhook is off: ${config.problem}`);
}
