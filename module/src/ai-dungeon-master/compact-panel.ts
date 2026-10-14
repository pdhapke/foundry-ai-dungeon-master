import type { AiDmClientState } from "./store.js";
/** Presentation only: never changes authentication, model eligibility or preparation. */
export function compactPanelState(state: AiDmClientState) {
  const provider = state.chatGpt;
  const connected = state.connection === "connected" && state.authenticatedLane === "gm";
  const authorized = provider.identityConnected && provider.planUsageAuthorized;
  let providerMessage = "";
  if (!connected) providerMessage = `${state.connectionMessage} Connect as a Foundry GM.`;
  else if (!provider.identityConnected) providerMessage = "Sign in to check account authorization for model use.";
  else if (!provider.planUsageAuthorized) providerMessage = "Account has not authorized model use. Reconnect ChatGPT or configure an authorized server API key.";
  else if (provider.modelSelectionPending) providerMessage = "Confirming selected model.";
  else if (provider.modelDiscoveryState === "unavailable") providerMessage = "Models could not be loaded. Use Account/settings: Check connection.";
  else if (provider.modelDiscoveryState === "empty") providerMessage = "No eligible models. Use Account/settings: Check connection.";
  else if (!provider.selectedModel) providerMessage = "Choose an eligible model.";
  else if (provider.state !== "ready" || !provider.availableModels.some(model => model.slug === provider.selectedModel)) providerMessage = "Selected model is unavailable. Choose an eligible model or use Account/settings: Check connection.";
  return { providerMessage, showSignIn: !authorized, signInLabel: provider.identityConnected ? "Reconnect ChatGPT" : "Continue with ChatGPT" };
}
export function compactStatusMessage(message: string): string {
  // Ordinary preparation-cache expiry is checked before the next request; it is
  // not an authentication failure and does not need a permanent idle banner.
  if (message === "Preparation expired. Refresh status or submit to check prerequisites again.") return "";
  return message.startsWith("Ready.") ? "" : message.replaceAll("Refresh status", "Account/settings: Check connection").replaceAll("refresh status", "check connection in Account/settings");
}
