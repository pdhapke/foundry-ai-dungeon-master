import { AiDungeonMasterApplication } from "./ai-dungeon-master/application.js";
import { aiDmController } from "./ai-dungeon-master/controller.js";
import { registerAiDungeonMasterHooks } from "./ai-dungeon-master/hooks.js";
import { cancelAutomaticEventLifecycle } from "./ai-dungeon-master/automatic-triggers.js";
import { createDotHookIntegration } from "./ai-dungeon-master/dot-hook-integration.js";
import { registerTunnelConfigurationMenu } from "./ai-dungeon-master/tunnel-configuration-menu.js";
import { registerDotRuntime } from "./ai-dungeon-master/dot-runtime.js";

const MODULE_ID = "foundry-ai-dungeon-master";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "serverUrl", {
    name: "AI Dungeon Master server URL",
    hint: "Loopback WebSocket URL for the local AI Dungeon Master server.",
    scope: "client",
    config: true,
    type: String,
    default: "ws://127.0.0.1:3940/ws",
    onChange: () => AiDungeonMasterApplication.settingsChanged("serverUrl"),
  });
  game.settings.register(MODULE_ID, "chatKitDomainKey", {
    name: "ChatKit domain key",
    hint: "Public ChatKit domain key registered for this Foundry browser origin.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true,
    onChange: () => AiDungeonMasterApplication.settingsChanged("chatKitDomainKey"),
  });
  game.settings.register(MODULE_ID, "latencyDiagnosticsEnabled", {
    name: "AI Dungeon Master developer diagnostics",
    hint: "Show metadata-only latency export in the account menu. Disabled by default.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => AiDungeonMasterApplication.settingsChanged("latencyDiagnosticsEnabled"),
  });
  game.settings.register(MODULE_ID, "automaticEventsEnabled", {
    name: "Enable AI Dungeon Master automatic events",
    hint: "Enable door-open, combat-turn and explicitly keyed area entry signals. Raw movement does not trigger turns.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
    onChange: () => cancelAutomaticEventLifecycle(),
  });
  game.settings.register(MODULE_ID, "dmEventMode", {
    name: "AI Dungeon Master automatic event controller",
    hint: "Embedded uses the local AI Dungeon Master. Dot uses a verified local-api controller binding for completed combat turns.",
    scope: "world",
    config: true,
    type: String,
    choices: { embedded: "Embedded", dot: "Dot" },
    default: "embedded",
    restricted: true,
    onChange: () => cancelAutomaticEventLifecycle(),
  });
  registerTunnelConfigurationMenu();
  registerDotRuntime();
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
  registerAiDungeonMasterHooks(createDotHookIntegration());
});

Hooks.once("ready", () => {
  aiDmController.connect();
  const module = (game as unknown as { modules?: Map<string, { api?: unknown }> }).modules?.get(
    MODULE_ID,
  );
  if (module)
    module.api = {
      ...(module.api as Record<string, unknown> | undefined),
      build: Object.freeze({
        policy: "core-actions-v1",
        bundleIdentity: "core-actions-v1",
        compactPanel: "prompt3-v1",
        scope: "Loaded module marker; compare server startup artifact hashes separately",
      }),
      open: () => AiDungeonMasterApplication.open(),
      trigger: (request: import("./ai-dungeon-master/chatkit-context.js").ChatKitTrigger) =>
        AiDungeonMasterApplication.open().trigger(request),
    };
});
