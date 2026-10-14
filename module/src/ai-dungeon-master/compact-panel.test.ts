import assert from "node:assert/strict";
import { it } from "node:test";
import { AiDmClientStore } from "./store.js";
import { compactPanelState, compactStatusMessage } from "./compact-panel.js";
void it("compact provider states preserve failures without healthy setup clutter", () => {
  const initial = new AiDmClientStore().state;
  const state = { ...initial, connection: "connected" as const, authenticatedLane: "gm" as const,
    chatGpt: { ...initial.chatGpt, state: "ready" as const, identityConnected: true, planUsageAuthorized: true,
      modelDiscoveryState: "available" as const, selectedModel: "model-one", availableModels: [{ slug: "model-one", displayName: "One" }] } };
  assert.equal(compactPanelState(state).providerMessage, "");
  assert.equal(compactPanelState(state).showSignIn, false);
  assert.equal(compactStatusMessage("Ready. Prerequisites checked."), "");
  assert.equal(compactStatusMessage("Preparation expired. Refresh status or submit to check prerequisites again."), "");
  assert.match(compactStatusMessage("Foundry authentication expired. Reconnect and try again."), /authentication expired/);
  assert.match(compactStatusMessage("Set the ChatKit domain key."), /domain key/);
  assert.match(compactPanelState({ ...state, connection: "disconnected" }).providerMessage, /Connect as a Foundry GM/);
  assert.equal(compactPanelState({ ...state, chatGpt: { ...state.chatGpt, identityConnected: false } }).showSignIn, true);
  assert.equal(compactPanelState({ ...state, chatGpt: { ...state.chatGpt, planUsageAuthorized: false } }).signInLabel, "Reconnect ChatGPT");
  assert.equal(compactPanelState({ ...state, chatGpt: { ...state.chatGpt, modelSelectionPending: true } }).showSignIn, false);
  assert.match(compactPanelState({ ...state, chatGpt: { ...state.chatGpt, availableModels: [] } }).providerMessage, /Selected model is unavailable/);
  assert.match(compactPanelState({ ...state, chatGpt: { ...state.chatGpt, modelDiscoveryState: "unavailable" } }).providerMessage, /Check connection/);
  assert.doesNotMatch(compactPanelState(state).providerMessage, /domain|Model available|model available/);
});
