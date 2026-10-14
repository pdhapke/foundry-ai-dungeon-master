import { z } from "zod";

import { ProtocolError } from "../../../../foundry-local-api/shared/dist/index.js";

import type {
  AiGmDeliveryService,
  DeliveryQueueSummary,
  DeliveryState,
  HostWakeAdapter,
} from "./ai-gm-delivery.js";
import {
  aiGmDeliveryItemOutputSchema,
  aiGmDeliveryListOutputSchema,
} from "./output-schemas.js";
import type { AnyEndpointDescriptor } from "./api-contract.js";

let service: AiGmDeliveryService | undefined;
let adapter: HostWakeAdapter | undefined;
let protocolError = (body: ConstructorParameters<typeof ProtocolError>[0]): Error => new ProtocolError(body);

export function configureAiGmDelivery(
  configuredService: AiGmDeliveryService | undefined,
  configuredAdapter: HostWakeAdapter | undefined,
  errorFactory: ((body: ConstructorParameters<typeof ProtocolError>[0]) => Error) = body => new ProtocolError(body),
): void {
  service = configuredService;
  adapter = configuredAdapter;
  protocolError = errorFactory;
}

function requireRuntime(): { service: AiGmDeliveryService; adapter: HostWakeAdapter } {
  if (!service || !adapter)
    throw protocolError({
      code: "INCOMPLETE_RESULT",
      message: "The durable AI-GM delivery runtime is not configured.",
      retryable: true,
    });
  return { service, adapter };
}

export interface AiGmDeliveryHealth extends DeliveryQueueSummary {
  consumerId: string;
  hostCapability: HostWakeAdapter["capability"];
  hostLimitation?: string;
}

/** Bounded health projection for validators that must not clone the full durable queue. */
export function getAiGmDeliveryHealth(): AiGmDeliveryHealth {
  const runtime = requireRuntime();
  return {
    consumerId: runtime.service.consumerId,
    hostCapability: runtime.adapter.capability,
    ...(runtime.adapter.limitation ? { hostLimitation: runtime.adapter.limitation } : {}),
    ...runtime.service.getQueueSummary(),
  };
}

const state = z.enum(["queued", "in_flight", "retry_wait", "acknowledged", "dead_letter"]);

export const aiGmDeliveryEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_list_ai_gm_deliveries",
    description:
      "Lists durable AI-GM movement work, acknowledgement, retry, dead-letter, and pending-adjudication state. Host wake capability and its precise limitation are reported without claiming polling is automatic delivery.",
    method: "get",
    path: "/ai-gm/deliveries",
    inputSchema: z.object({ states: z.array(state).max(5).optional() }).strict(),
    outputSchema: aiGmDeliveryListOutputSchema,
    handler: (input: { states?: DeliveryState[] }) => {
      const runtime = requireRuntime();
      return {
        consumerId: runtime.service.consumerId,
        hostCapability: runtime.adapter.capability,
        ...(runtime.adapter.limitation ? { hostLimitation: runtime.adapter.limitation } : {}),
        reconciliationWatermark: runtime.service.getReconciliationWatermark() ?? null,
        items: runtime.service.list(input.states),
      };
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "foundry_get_ai_gm_delivery",
    description:
      "Reads one durable AI-GM movement delivery item by its stable delivery ID, including event/cursor linkage, attempt history, acknowledgement, failure, and pending-adjudication state.",
    method: "get",
    path: "/ai-gm/deliveries/:deliveryId",
    inputSchema: z.object({ deliveryId: z.string().min(1).max(256) }).strict(),
    outputSchema: aiGmDeliveryItemOutputSchema,
    handler: (input: { deliveryId: string }) => {
      const runtime = requireRuntime();
      const item = runtime.service.get(input.deliveryId);
      if (!item)
        throw protocolError({
          code: "NOT_FOUND",
          message: `AI-GM delivery "${input.deliveryId}" was not found.`,
          retryable: false,
          fieldPath: "deliveryId",
        });
      return item;
    },
    annotations: { readOnlyHint: true },
  },
];
