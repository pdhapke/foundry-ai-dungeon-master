import type { AiDmClientState } from "./store.js";
/** Only display provider readiness; never copy identity details or credentials into the panel. */
export function chatGptPanelStatus(state: AiDmClientState): string {
  if (state.connection !== "connected" || state.authenticatedLane !== "gm")
    return `${state.connectionMessage} Connect as a Foundry GM to continue with ChatGPT.`;
  const provider = state.chatGpt;
  if (!provider.identityConnected)
    return "Continue with ChatGPT to check whether this account authorizes model use. A subscription alone does not guarantee API access.";
  if (!provider.planUsageAuthorized)
    return "ChatGPT sign-in connected your identity, but this account did not authorize model use. Reconnect to check authorization, or configure an authorized API key on the server.";
  if (provider.modelDiscoveryState === "unavailable")
    return "Eligible models could not be loaded. Select Refresh status; if this persists, reconnect ChatGPT.";
  if (provider.modelDiscoveryState === "empty")
    return "This account returned no eligible models. Refresh status or use an authorized server API key.";
  if (provider.modelSelectionPending) return "Confirming selected model…";
  if (!provider.selectedModel) return "Choose an eligible model to use ChatGPT authorization.";
  return `ChatGPT model available: ${provider.selectedModel}. ChatKit also needs its registered domain key.`;
}
