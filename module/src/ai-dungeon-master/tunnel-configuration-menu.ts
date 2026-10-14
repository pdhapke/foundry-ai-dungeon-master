const MODULE_ID = "foundry-ai-dungeon-master";
const BRIDGE_MODULE_ID = "foundry-local-api";

/** Resolve the existing companion UI only when the GM opens it. No key, saved
 * config, module load order or initialization-time user is captured here. */
export async function openTunnelConfiguration(): Promise<void> {
  if (!game.user?.isGM || game.user.name?.toLowerCase() === "tv") {
    ui.notifications.warn("Open tunnel configuration as the connected local GM.");
    return;
  }
  const modules = (game as unknown as { modules?: Map<string, { active?: boolean; api?: unknown }> }).modules;
  const bridge = modules?.get(BRIDGE_MODULE_ID);
  if (!bridge || bridge.active !== true) {
    ui.notifications.warn("Enable Foundry local api and mcp in Module Management to use AI Dungeon Master tunnel configuration.");
    return;
  }
  const api = modules?.get(MODULE_ID)?.api as { dotTunnelSetup?: { show?: unknown } } | undefined;
  const setup = api?.dotTunnelSetup;
  if (typeof setup?.show !== "function") {
    ui.notifications.warn("AI Dungeon Master tunnel controls are not ready. Wait for the GM bridge to connect, then reopen Configure tunnel.");
    return;
  }
  try { await (setup.show as () => unknown).call(setup); }
  catch { ui.notifications.error("Tunnel configuration could not open. Check the local GM bridge connection, then try again."); }
}

/** Configure Settings lists this menu beside this module's dot mode and event
 * settings. Registration on init never reads game.user or the companion API. */
export function registerTunnelConfigurationMenu(): void {
  const settings = game.settings as unknown as { registerMenu?: (namespace: string, key: string, options: Record<string, unknown>) => void };
  const Application = foundry.applications?.api?.ApplicationV2;
  if (!settings.registerMenu || !Application) return;
  class TunnelConfigurationMenu extends Application {
    override render(): this {
      void openTunnelConfiguration();
      return this;
    }
  }
  settings.registerMenu(MODULE_ID, "tunnelConfiguration", {
    name: "OpenAI dot tunnel configuration", label: "Configure tunnel",
    hint: "OpenAI dot tunnel ID and runtime key. Install the official tool, configure the existing private tunnel, and explicitly Activate or Stop. Saved configuration remains with the local companion; no key re-entry is needed to open this menu.",
    icon: "fas fa-link", type: TunnelConfigurationMenu, restricted: true,
  });
}
