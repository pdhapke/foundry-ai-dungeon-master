import type { MovementEventStore as Store } from "../../../../foundry-local-api/server/dist/events/movement-event-store.js";

/** Test-only use of the real generic store; production consumes the host contract. */
const implementation = await import(new URL("../../../../foundry-local-api/server/src/events/movement-event-store.ts", import.meta.url).href) as { MovementEventStore: typeof Store };
export const MovementEventStore = implementation.MovementEventStore;
