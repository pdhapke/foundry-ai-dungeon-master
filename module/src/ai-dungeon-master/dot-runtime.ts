import { DotBridge, foundryDotNative, registerDotCommands, type DotStorage } from "../dot-bridge.js";
import { DotTunnelSetupClient, registerDotTunnelSetupButton, showDotTunnelSetup } from "../dot-tunnel-setup.js";
import { TunnelConfigurationClient } from "../tunnel-configuration.js";
import { validatePreparedScene } from "./prepared-scene-guard.js";

const MODULE_ID = "foundry-ai-dungeon-master";
const API_MODULE_ID = "foundry-local-api";
export interface GenericBridgeApi {
  version: 1;
  identity(): { clientId: string; userId: string; lane: string; connected: boolean };
  registerCommand(type: string, handler: (payload: unknown) => unknown): () => void;
  registerDocumentGuard(name: string, handler: (context: unknown) => void): () => void;
  sendEvent(name: string, payload: unknown): void;
  sendPrivate(payload: unknown): void;
  onMessage(listener: (payload: unknown) => boolean): () => void;
  onStatus(listener: (status: "disconnected" | "connecting" | "connected") => void): () => void;
  onPump(listener: () => void): () => void;
}
type ModuleEntry = { active?: boolean; api?: Record<string, unknown> };
function modules(): Map<string, ModuleEntry> | undefined {
  return (game as unknown as { modules?: Map<string, ModuleEntry> }).modules;
}
function availableBridge(): GenericBridgeApi | undefined {
  const module = modules()?.get(API_MODULE_ID);
  const api = module?.api?.["bridge"] as Partial<GenericBridgeApi> | undefined;
  if (module?.active === false || api?.version !== 1) return;
  if ([api.identity, api.registerCommand, api.registerDocumentGuard, api.sendEvent, api.sendPrivate, api.onMessage, api.onStatus, api.onPump].some(fn => typeof fn !== "function")) return;
  return api as GenericBridgeApi;
}
function browserStorage(): DotStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return; }
}

/** AI DM owns all dot commands, controller policy, retained browser state and
 * tunnel UI. The generic bridge supplies verified transport identity only. */
export function createDotRuntime(api: GenericBridgeApi, storage = browserStorage()) {
  const identity = api.identity();
  if (identity.lane !== "gm" || !game.user?.isGM || game.user.name?.toLowerCase() === "tv" || identity.userId !== game.user.id) throw new Error("AI DM requires the current GM bridge.");
  const authority = () => {
    const current = api.identity();
    return current.connected && current.lane === "gm" && current.clientId === identity.clientId && current.userId === identity.userId && game.user?.id === identity.userId && game.user.isGM && game.user.name?.toLowerCase() !== "tv";
  };
  const world = () => {
    const id = game.world?.id;
    if (!id) throw new Error("Current Foundry world unavailable.");
    return id;
  };
  const dot = new DotBridge(identity.clientId, identity.userId, storage, { ...foundryDotNative, authority: binding => authority() && foundryDotNative.authority(binding) }, (name, payload) => api.sendEvent(name, payload));
  const configuration = new TunnelConfigurationClient(identity.clientId, authority, world, payload => api.sendPrivate(payload));
  const setup = new DotTunnelSetupClient(identity.clientId, authority, () => api.identity().connected, world, (name, payload) => api.sendEvent(name, payload), configuration);
  const disposers: (() => void)[] = [];
  const requestBinding = () => {
    try {
      if (authority() && game.settings.get(MODULE_ID, "dmEventMode") === "dot" && game.settings.get(MODULE_ID, "automaticEventsEnabled") === true) dot.requestBinding();
      else dot.unbind();
    } catch { dot.unbind(); }
  };
  const setupScope = () => {
    const sceneId = canvas?.scene?.id;
    if (!authority() || !sceneId) throw new Error("Current GM scene unavailable.");
    return { worldId: world(), sceneId, clientId: identity.clientId, userId: identity.userId };
  };
  try {
    disposers.push(api.registerDocumentGuard("preparation", validatePreparedScene));
    disposers.push(...registerDotCommands(dot, (type, handler) => api.registerCommand(type, handler)));
    disposers.push(api.registerCommand("dotSetupScope", setupScope));
    disposers.push(api.registerCommand("dotSetupReadiness", () => ({ controller: setupScope(), automaticEventsEnabled: game.settings.get(MODULE_ID, "automaticEventsEnabled") === true, dmEventMode: game.settings.get(MODULE_ID, "dmEventMode") })));
    disposers.push(api.onMessage(payload => configuration.receive(payload) || setup.receive(payload) || dot.receive(payload)));
    disposers.push(api.onStatus(status => {
      dot.setConnected(status === "connected" && authority());
      if (status !== "connected") { setup.disconnected(); configuration.disconnected(); }
      requestBinding();
    }));
    disposers.push(api.onPump(() => dot.pump()));
    dot.setConnected(identity.connected);
    requestBinding();
  } catch {
    for (const dispose of disposers.reverse()) dispose();
    dot.setConnected(false); dot.unbind();
    throw new Error("AI DM bridge extension could not initialize.");
  }
  return { dot, setup, requestBinding, dispose() {
    for (const dispose of disposers.reverse()) dispose();
    dot.setConnected(false); dot.unbind(); setup.disconnected(); configuration.disconnected();
  } };
}

/** Both ready orders are supported: late module lookup and the explicit bridge
 * publication hook. Repeated publication never creates a second controller. */
export function registerDotRuntime(): void {
  let attached: GenericBridgeApi | undefined;
  let runtime: ReturnType<typeof createDotRuntime> | undefined;
  const attach = () => {
    const api = availableBridge();
    if (api === attached) return;
    runtime?.dispose(); runtime = undefined; attached = undefined;
    const module = modules()?.get(MODULE_ID);
    if (module?.api) { delete module.api["dot"]; delete module.api["dotTunnelSetup"]; }
    if (!api) return;
    try {
      runtime = createDotRuntime(api); attached = api;
      if (module) module.api = { ...module.api, dot: runtime.dot, dotTunnelSetup: { show: () => showDotTunnelSetup(runtime!.setup), status: () => runtime!.setup.request("status") } };
    } catch { /* A non-GM or unavailable bridge leaves dot disabled. */ }
  };
  registerDotTunnelSetupButton(() => runtime?.setup);
  Hooks.on("foundry-local-api.bridgeReady", attach);
  Hooks.on("ready", () => queueMicrotask(attach));
  Hooks.on("canvasReady", () => runtime?.requestBinding());
  Hooks.on("updateSetting", (setting: unknown) => {
    const key = (setting as { key?: string })?.key;
    if (key === `${MODULE_ID}.dmEventMode` || key === `${MODULE_ID}.automaticEventsEnabled`) runtime?.requestBinding();
  });
}
