import { AiDungeonMasterApplication } from "./ai-dungeon-master/application.js";
import { aiDmController } from "./ai-dungeon-master/controller.js";
import { registerAiDungeonMasterHooks } from "./ai-dungeon-master/hooks.js";

const MODULE_ID = "foundry-ai-dungeon-master";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "serverUrl", {
    name: "AI Dungeon Master server URL",
    hint: "Loopback WebSocket URL for the local AI Dungeon Master server.",
    scope: "client",
    config: true,
    type: String,
    default: "ws://127.0.0.1:3940/ws",
  });
  game.settings.register(MODULE_ID, "chatKitDomainKey", {
    name: "ChatKit domain key",
    hint: "Public ChatKit domain key registered for this Foundry browser origin.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true,
  });
  game.settings.register(MODULE_ID, "automaticEventsEnabled", {
    name: "Enable AI Dungeon Master automatic events",
    hint: "Enable reviewed combat, door, Region, Item, and Scene event adapters. Movement remains disabled.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
  });
  game.settings.register(MODULE_ID, "allowAllPlayerRequests", {
    name: "Automatically approve all player AI requests",
    hint: "When enabled, player prompts run automatically under the connected GM's authority.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
  });
  game.keybindings.register(MODULE_ID, "open", {
    name: "Open AI Dungeon Master",
    hint: "Open the AI Dungeon Master window.",
    editable: [{ key: "KeyD", modifiers: ["Control", "Shift"] }],
    onDown: () => {
      AiDungeonMasterApplication.open();
      return true;
    },
    restricted: false,
  });
  registerAiDungeonMasterHooks();
});

Hooks.once("ready", () => {
  aiDmController.connect();
  const module = (game as unknown as { modules?: Map<string, { api?: unknown }> }).modules?.get(
    MODULE_ID,
  );
  if (module)
    module.api = {
      open: () => AiDungeonMasterApplication.open(),
      trigger: (request: import("./ai-dungeon-master/chatkit-context.js").ChatKitTrigger) =>
        AiDungeonMasterApplication.open().trigger(request),
    };
});
