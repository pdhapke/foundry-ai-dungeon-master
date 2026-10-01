import assert from "node:assert/strict";
import { it } from "node:test";
import { AiDmClientStore } from "./store.js";
import { chatGptPanelStatus } from "./chatgpt-panel.js";
void it("ChatGPT authorization panel explains readiness failures without identity or credentials (mocked status)", () => {
  const store = new AiDmClientStore();
  assert.match(chatGptPanelStatus(store.state), /Connect as a Foundry GM/);
  store.setAuthenticated("gm", "Connected");
  assert.match(chatGptPanelStatus(store.state), /subscription alone/);
  const apply = (
    identityConnected: boolean,
    planUsageAuthorized: boolean,
    modelDiscoveryState: "not-authorized" | "unavailable" | "empty" | "available",
    models: Array<{ slug: string; displayName: string }> = [],
    selectedModel: string | null = null,
  ) =>
    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request",
        state: identityConnected ? "connected" : "signed-out",
        identityConnected,
        planUsageAuthorized,
        modelDiscoveryState,
        availableModels: models,
        selectedModel,
        email: "private@example.com",
      },
    });
  apply(true, false, "not-authorized");
  assert.match(chatGptPanelStatus(store.state), /did not authorize model use/);
  assert.doesNotMatch(chatGptPanelStatus(store.state), /private@example/);
  apply(true, true, "unavailable");
  assert.match(chatGptPanelStatus(store.state), /Refresh status/);
  apply(true, true, "empty");
  assert.match(chatGptPanelStatus(store.state), /no eligible models/);
  apply(true, true, "available", [{ slug: "model-one", displayName: "Model one" }], "model-one");
  assert.match(chatGptPanelStatus(store.state), /model-one/);
  store.setModelSelectionPending(true);
  assert.match(chatGptPanelStatus(store.state), /Confirming/);
});
