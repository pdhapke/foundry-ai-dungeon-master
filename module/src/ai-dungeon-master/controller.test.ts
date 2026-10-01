import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AiDmClientMessage } from "@foundry-ai-dungeon-master/shared";

void describe("AI Dungeon Master model selection", () => {
  void it("allows only an authenticated GM to select a server-advertised eligible model", async () => {
    Object.assign(globalThis, {
      window: { addEventListener: () => undefined },
    });
    const [{ AiDmController }, { AiDmClientStore }] = await Promise.all([
      import("./controller.js"),
      import("./store.js"),
    ]);
    const sent: AiDmClientMessage[] = [];
    const store = new AiDmClientStore();
    const controller = new AiDmController(store, {
      connect: () => undefined,
      beginChatGptSignIn: () => false,
      send: (command) => {
        sent.push(command);
        return true;
      },
    });
    store.setAuthenticated("gm", "Connected");
    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-model-status",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "available",
        availableModels: [
          { slug: "gpt-5.4-mini", displayName: "GPT-5.4 mini" },
          { slug: "gpt-5.4", displayName: "GPT-5.4" },
        ],
        selectedModel: "gpt-5.4-mini",
      },
    });

    assert.equal(controller.selectChatGptModel("not-advertised"), false);
    assert.equal(sent.length, 0);
    assert.equal(controller.selectChatGptModel("gpt-5.4"), true);
    assert.deepEqual(
      sent.map(({ type }) => type),
      ["aiDm.chatgpt.model.select", "aiDm.chatgpt.status"],
    );
    assert.equal(store.state.chatGpt.modelSelectionPending, true);

    store.setAuthenticated("player", "Connected");
    store.setModelSelectionPending(false);
    assert.equal(controller.selectChatGptModel("gpt-5.4-mini"), false);
    assert.equal(sent.length, 2);
  });

  void it("blocks GM inference until authoritative provider readiness is restored", async () => {
    Object.assign(globalThis, {
      window: { addEventListener: () => undefined },
      canvas: { scene: null, tokens: { controlled: [], placeables: [] } },
    });
    const [{ AiDmController }, { AiDmClientStore }] = await Promise.all([
      import("./controller.js"),
      import("./store.js"),
    ]);
    const sent: AiDmClientMessage[] = [];
    const store = new AiDmClientStore();
    const controller = new AiDmController(store, {
      connect: () => undefined,
      beginChatGptSignIn: () => false,
      send: (command) => {
        sent.push(command);
        return true;
      },
    });
    store.setAuthenticated("gm", "Connected");

    assert.equal(controller.submitPrompt("First prompt", { kind: "private" }), false);
    assert.equal(sent.length, 0);

    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-ready",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "available",
        availableModels: [{ slug: "gpt-5.5", displayName: "GPT-5.5" }],
        selectedModel: "gpt-5.5",
      },
    });
    assert.equal(controller.submitPrompt("Second prompt", { kind: "private" }), true);
    assert.equal(sent.at(-1)?.type, "aiDm.prompt.submit");

    store.applyControlMessage({
      type: "aiDm.chatgpt.status",
      payload: {
        requestId: "request-unavailable",
        state: "connected",
        identityConnected: true,
        planUsageAuthorized: true,
        modelDiscoveryState: "unavailable",
        availableModels: [],
        selectedModel: null,
      },
    });
    assert.equal(
      controller.submitEvent({
        requestId: "automatic-event-1",
        eventType: "scene.changed",
        sourceCorrelationId: "scene:one",
        presentation: "collapsed",
        contextHints: {
          controlledTokenIds: [],
          controlledActorIds: [],
          targetTokenIds: [],
          selectedDocumentUuids: [],
        },
        payload: {},
      }),
      false,
    );
    assert.equal(sent.length, 1);
  });

  void it("does not expose the nonfunctional run retry action", async () => {
    Object.assign(globalThis, { window: { addEventListener: () => undefined } });
    const [{ AiDmController }, { AiDmClientStore }] = await Promise.all([
      import("./controller.js"),
      import("./store.js"),
    ]);
    const controller = new AiDmController(new AiDmClientStore(), {
      connect: () => undefined,
      beginChatGptSignIn: () => false,
      send: () => true,
    });
    assert.equal("retry" in controller, false);
  });
});
