import { registerExtension as registerDot } from "./dot-integration/extension.js";
import { registerLegacyDelivery } from "./legacy-delivery/extension.js";
import type { LegacyDeliveryContext } from "./legacy-delivery/api-contract.js";

/** Explicit AI DM extension composition; generic API does not discover or import it. */
export function registerExtension(context: LegacyDeliveryContext): void {
  registerDot(context);
  registerLegacyDelivery(context);
}
export default registerExtension;
