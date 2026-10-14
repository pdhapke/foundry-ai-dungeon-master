import { configurationFields, takeConfigurationInput, TunnelConfigurationRequestError, type TunnelConfigurationClient, type TunnelConfigurationInput, type TunnelConfigurationStatus } from "./tunnel-configuration.js";
export const TUNNEL_SETUP_EVENT = "foundry.dot_tunnel_tool_setup";
export type TunnelSetupAction = "status" | "enable" | "disable" | "install" | "rollback";
export interface TunnelSetupStatus { enabled: boolean; phase: string; requiredVersion: string; platform: string; installedVersion?: string; retainedVersion?: string; rollbackAvailable?: boolean; restartNeeded?: boolean; message: string; errorCode?: string }
/** One bounded browser request at a time; no privileged HTTP credential or
 * binary download is present in the browser. Explicit setup UI drives requests.
 */
export class DotTunnelSetupClient {
  private pending: { id: string; resolve(value: TunnelSetupStatus): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  constructor(private readonly clientId: string, private readonly authority: () => boolean, private readonly connected: () => boolean, private readonly world: () => string, private readonly send: (event: string, payload: unknown) => void, readonly configuration?: TunnelConfigurationClient) {}
  request(action: TunnelSetupAction): Promise<TunnelSetupStatus> {
    if (!this.authority() || !this.connected()) return Promise.reject(new Error("Open Foundry as the connected GM to use tunnel tool setup."));
    if (this.pending) return Promise.reject(new Error("Setup request is pending. Wait for its result before requesting another action."));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; reject(new Error("Companion setup timed out. Check its connection and retry Status; an installation may still be completing.")); }, action === "install" ? 160000 : 15000);
      this.pending = { id: requestId, resolve, reject, timer };
      try { this.send(TUNNEL_SETUP_EVENT, { requestId, worldId: this.world(), action, ...(["install", "rollback"].includes(action) ? { confirmed: true } : {}) }); }
      catch { this.disconnected(); }
    });
  }
  receive(raw: unknown): boolean {
    const value = raw as { kind?: string; clientId?: string; requestId?: string; status?: TunnelSetupStatus };
    if (value?.kind !== "dot-tunnel-tool-status") return false;
    const pending = this.pending;
    if (!pending || value.clientId !== this.clientId || value.requestId !== pending.id) return true;
    const status = value.status;
    if (!status || typeof status.enabled !== "boolean" || !["unsupported", "not_installed", "installed", "different_version", "installing", "error"].includes(status.phase) || typeof status.requiredVersion !== "string" || status.requiredVersion.length > 32 || typeof status.platform !== "string" || status.platform.length > 40 || typeof status.message !== "string" || status.message.length > 1024 || [status.installedVersion, status.retainedVersion, status.errorCode].some(value => value !== undefined && (typeof value !== "string" || value.length > 64)) || [status.rollbackAvailable, status.restartNeeded].some(value => value !== undefined && typeof value !== "boolean")) { this.disconnected(); return true; }
    clearTimeout(pending.timer); this.pending = undefined; pending.resolve(status); return true;
  }
  disconnected(): void { if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error("Foundry companion connection was interrupted. Reconnect and check Status.")); this.pending = undefined; } }
}

interface DialogApi { wait(options: Record<string, unknown>): Promise<unknown> }
interface SetupDialog { close(): Promise<unknown> }
const openSetups = new WeakMap<DotTunnelSetupClient, Promise<void>>();
/** Native wait resolves on submit before its close animation finishes. Waiting
 * for close prevents replacing controls underneath a rapid follow-up click. */
async function closedDialog(dialog: DialogApi, options: Record<string, unknown>): Promise<unknown> {
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const result = await dialog.wait({ ...options, close: () => { try { const close = options["close"]; if (typeof close === "function") (close as () => void)(); } finally { finish(); } } });
  await closed; return result;
}
export function showDotTunnelSetup(client: DotTunnelSetupClient): Promise<void> {
  const existing = openSetups.get(client);
  if (existing) { ui.notifications.notify("Tunnel setup is already open or working. Repeated clicks do not start another installation.", "info"); return existing; }
  const work = runDotTunnelSetup(client).finally(() => { openSetups.delete(client); });
  openSetups.set(client, work); return work;
}
const escaped = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function diagnosticFields(lifecycle: TunnelConfigurationStatus["lifecycle"]): string {
  if (!lifecycle?.diagnosticId) return "";
  const file = `%LOCALAPPDATA%\\FoundryDot\\diagnostic-${lifecycle.diagnosticId}.json`;
  return `<p>Last activation diagnostic: <code>${escaped(lifecycle.diagnosticId)}</code>. Code: <code>${escaped(lifecycle.hostFailureCode ?? lifecycle.reason)}</code>${lifecycle.failurePhase ? `. Failure phase: <code>${escaped(lifecycle.failurePhase)}</code>` : ""}.</p>${lifecycle.diagnosticStorage === "saved" ? `<p>Saved local diagnostic: <code>${escaped(file)}</code>. Paste this path into File Explorer to find the report.</p>` : "<p>The diagnostic could not be saved. No diagnostic file was confirmed. Keep the reference ID for local troubleshooting.</p>"}`;
}
/** Render before starting either bounded status request. Closing abandons this
 * view only; a late read cannot reopen it or submit a second request. */
async function loadingStatus<T>(dialog: DialogApi, read: (cancelled: () => boolean) => Promise<T | undefined>): Promise<T | undefined> {
  let cancelled = false, finished = false, progressWindow: SetupDialog | undefined;
  const progress = dialog.wait({ window: { title: "Loading tunnel configuration" },
    content: "<p role=\"status\">Checking the companion connection, installed tool and private configuration. Please wait while local checks complete.</p><p>Save and Activate become available only after status verification. No configuration is being changed and no tunnel will start.</p>",
    buttons: [{ action: "close", label: "Close", callback: () => { cancelled = true; return "close"; } }], rejectClose: false,
    close: () => { if (!finished) cancelled = true; },
    render: (_event: unknown, instance: SetupDialog) => { progressWindow = instance; if (finished) void instance.close().catch(() => undefined); },
  });
  // Handle a user close or renderer rejection before the read completes.
  void progress.then(() => { if (!finished) cancelled = true; }, () => { cancelled = true; });
  let value: T | undefined;
  try { value = await read(() => cancelled); }
  catch (error) { if (!cancelled) throw error; }
  finally {
    finished = true;
    await progressWindow?.close();
    await progress.catch(() => undefined);
  }
  return cancelled ? undefined : value;
}
async function runDotTunnelSetup(client: DotTunnelSetupClient): Promise<void> {
  if (!game.user?.isGM || game.user.name?.toLowerCase() === "tv") return;
  const dialog = (globalThis as unknown as { foundry?: { applications?: { api?: { DialogV2?: DialogApi } } } }).foundry?.applications?.api?.DialogV2;
  if (!dialog) { ui.notifications.notify("Tunnel setup requires Foundry's DialogV2. Ask the operator to check the supported Foundry version.", "error"); return; }
  try {
    let configurationUnavailable = false;
    let configurationError = "";
    const readConfiguration = async () => {
      if (!client.configuration) return;
      try { const value = await client.configuration.request({ action: "status" }); configurationUnavailable = false; configurationError = ""; return value; }
      catch (error) { configurationUnavailable = true; configurationError = error instanceof TunnelConfigurationRequestError ? error.message : "Private configuration is unavailable. Refresh status after checking the GM connection."; return; }
    };
    const readStatus = () => loadingStatus(dialog, async cancelled => {
      const status = await client.request("status");
      if (cancelled()) return;
      const configuration = await readConfiguration();
      if (cancelled()) return;
      return { status, configuration };
    });
    const loaded = await readStatus();
    if (!loaded || !game.user?.isGM) return;
    let { status, configuration } = loaded;
    while (game.user?.isGM) {
      let form: HTMLElement | undefined;
      const choices = [...(configuration ? [{ action: "save", label: "Save configuration", disabled: configuration.lifecycle?.canStop === true },
        { action: "activate", label: "Activate", disabled: configuration.lifecycle?.canActivate !== true },
        { action: "stop", label: "Stop", disabled: configuration.lifecycle?.canStop !== true }] : []), { action: "status", label: "Refresh status" },
        ...(status.phase !== "unsupported" ? [status.enabled ? { action: "disable", label: "Disable downloads" } : { action: "enable", label: "Enable downloads for this session" }] : []),
        ...(status.enabled && !["unsupported", "installed", "installing"].includes(status.phase) ? [{ action: "install", label: "Install required version" }] : []),
        ...(status.enabled && status.rollbackAvailable ? [{ action: "rollback", label: "Restore verified prior version" }] : []),
        { action: "close", label: "Close" }];
      const action = await closedDialog(dialog, { window: { title: configuration ? "Foundry tunnel configuration" : "Foundry tunnel tool setup" },
        content: `${configuration ? configurationFields(configuration) : ""}${configurationUnavailable ? `<p role="alert">Private configuration is unavailable. ${escaped(configurationError)} Save is unavailable until status verification succeeds.</p>` : ""}<p>Required tool: ${escaped(status.requiredVersion)} (${escaped(status.platform)})</p><p>Installed: ${escaped(status.installedVersion ?? "None")}</p>${status.retainedVersion ? `<p>Retained: ${escaped(status.retainedVersion)}. ${status.rollbackAvailable ? "Verified rollback available." : "Rollback needs a reviewed manifest in an app update."}</p>` : ""}${status.restartNeeded ? "<p>Restart an existing tunnel through the supported launcher to use the selected version.</p>" : ""}<p>${escaped(status.message)}</p>${configuration ? `<p>${escaped(configuration.lifecycle?.message ?? "Activation status is unavailable. Refresh status.")}</p><p>Process: ${escaped(configuration.lifecycle?.phase ?? "inactive")}. Local health: ${configuration.lifecycle?.healthy === null || configuration.lifecycle?.healthy === undefined ? "Unknown" : configuration.lifecycle.healthy ? "Healthy" : "Unhealthy"}. Local readiness: ${configuration.lifecycle?.ready === null || configuration.lifecycle?.ready === undefined ? "Unknown" : configuration.lifecycle.ready ? "Ready" : "Not ready"}.</p><p>Local readiness does not confirm a ChatGPT connection or event delivery.</p>${diagnosticFields(configuration.lifecycle)}` : "<p>Tunnel access, credentials and activation are separate steps.</p>"}`,
        render: (_event: unknown, instance: { element?: HTMLElement }) => { form = instance.element; },
        close: () => { const key = form?.querySelector<HTMLInputElement>('[name="dot-runtime-key"]'); if (key) key.value = ""; },
        buttons: choices.map(choice => ({ ...choice, callback: () => choice.action === "save" && form && configuration ? takeConfigurationInput(form, configuration.controller) : choice.action })), rejectClose: false });
      if (action && typeof action === "object" && (action as TunnelConfigurationInput).action === "save" && client.configuration) {
        const input = action as TunnelConfigurationInput;
        try {
          if (input.rotateRuntimeKey) {
            const confirmed = await closedDialog(dialog, { window: { title: "Replace tunnel runtime key" }, content: "<p>Replace the saved OpenAI tunnel runtime key with the new value you entered? No tunnel will be started.</p>", buttons: [{ action: "confirm", label: "Replace key", callback: () => true }, { action: "cancel", label: "Cancel", callback: () => false }], rejectClose: false });
            if (confirmed !== true) continue;
          }
          // Private Save can take many seconds while Windows ACLs are checked.
          // Keep one progress screen and pending ID; neither contains the key.
          let progressWindow: SetupDialog | undefined, finished = false;
          const progress = dialog.wait({ window: { title: "Saving private tunnel configuration" }, content: "<p>Verifying private Windows permissions and saving configuration. This may take up to six minutes. The runtime key has been cleared from the form.</p><p>Do not submit another key while this save is pending. No tunnel will start.</p>", buttons: [{ action: "hide", label: "Hide progress", type: "button" }], rejectClose: false, render: (_event: unknown, instance: SetupDialog) => { progressWindow = instance; if (finished) void instance.close(); } });
          void progress.catch(() => undefined);
          try { configuration = await client.configuration.request(input); }
          finally { finished = true; await progressWindow?.close(); }
          await progress;
          if (!configuration.configured || !configuration.runtimeKeyConfigured || !configuration.bridgeKeyConfigured) throw new TunnelConfigurationRequestError("Save did not confirm all required private files. Refresh status before entering another key.");
          ui.notifications.notify("Runtime key and tunnel configuration saved privately. Activation requires a separate confirmation.", "info");
        } catch (error) {
          configuration = undefined; configurationUnavailable = true;
          configurationError = error instanceof TunnelConfigurationRequestError ? error.message : "Save did not confirm completion. Refresh status before entering another key; an interrupted save requires local review.";
          ui.notifications.notify(configurationError, "warning");
        } finally { delete input.runtimeKey; }
        continue;
      }
      if ((action === "activate" || action === "stop") && configuration && client.configuration) {
        const permitted = action === "activate" ? configuration.lifecycle?.canActivate : configuration.lifecycle?.canStop;
        if (!permitted) continue;
        const confirmed = await closedDialog(dialog, { window: { title: action === "activate" ? "Activate Foundry tunnel" : "Stop Foundry tunnel" },
          content: action === "activate" ? "<p>Start the official client in the existing visible Foundry console using the saved private profile? This connects the configured dot MCP endpoint to OpenAI. The current GM, scene, dot mode, pinned tools and security guards will be checked again.</p>" : "<p>Revoke the dot endpoint, cancel pending responses and stop the tunnel process owned by this session? Retained events remain paused for the same controller.</p>",
          buttons: [{ action: "confirm", label: action === "activate" ? "Activate" : "Stop", callback: () => true }, { action: "cancel", label: "Cancel", callback: () => false }], rejectClose: false });
        if (confirmed !== true) continue;
        ui.notifications.notify(action === "activate" ? "Checking prerequisites and starting the visible tunnel host. Please wait." : "Revoking the endpoint and stopping the owned tunnel. Please wait.", "info");
        try {
          configuration = await client.configuration.request({ action, confirmed: true, expectedController: { ...configuration.controller } });
          ui.notifications.notify(configuration.lifecycle?.message ?? "Refresh status to verify the result.", configuration.lifecycle?.phase === "failed" ? "warning" : "info");
        } catch (error) {
          configuration = undefined; configurationUnavailable = true;
          configurationError = error instanceof TunnelConfigurationRequestError ? error.message : "Lifecycle result is uncertain. Refresh status before retrying.";
          ui.notifications.notify(configurationError, "warning");
        }
        continue;
      }
      if (!["status", "enable", "disable", "install", "rollback"].includes(String(action))) break;
      if (action === "install" || action === "rollback") {
        const confirmed = await closedDialog(dialog, { window: { title: action === "rollback" ? "Restore verified prior tunnel tool" : "Install required tunnel tool" }, content: action === "rollback" ? `<p>Restore verified ${escaped(status.retainedVersion)}? Restart an existing tunnel through the supported launcher afterward.</p>` : `<p>Download and verify official OpenAI ${escaped(status.requiredVersion)} for ${escaped(status.platform)}? The complete tool bundle will be stored with Foundry. It will not start a tunnel.</p>`, buttons: [{ action: "confirm", label: action === "rollback" ? "Restore" : "Install", callback: () => true }, { action: "cancel", label: "Cancel", callback: () => false }], rejectClose: false });
        if (confirmed !== true) continue;
        ui.notifications.notify(action === "rollback" ? "Verifying and restoring the retained tunnel tool." : "Downloading and verifying the tunnel tool.", "info");
      }
      if (action === "install" || action === "rollback") {
        let progressWindow: SetupDialog | undefined, finished = false;
        const progress = dialog.wait({ window: { title: "Foundry tunnel tool setup — working" }, content: "<p>Installation is in progress. The companion is downloading and verifying the selected bundle. No additional installation is needed while this request is pending.</p><p>Hide this window to continue using Foundry; the result will appear when the request finishes.</p>", buttons: [{ action: "hide", label: "Hide progress", type: "button" }], rejectClose: false, render: (_event: unknown, instance: SetupDialog) => { progressWindow = instance; if (finished) void instance.close(); } });
        void progress.catch(() => undefined);
        try { status = await client.request(action); }
        finally { finished = true; await progressWindow?.close(); }
        await progress;
      } else if (action === "status") {
        const refreshed = await readStatus();
        if (!refreshed) break;
        ({ status, configuration } = refreshed);
      } else { status = await client.request(action as TunnelSetupAction); configuration = await readConfiguration(); }
    }
  } catch { ui.notifications.notify("Tunnel status could not be verified. Check the local GM companion connection, then reopen tunnel configuration.", "error"); }
}

/** Lower-level Settings sidebar shortcut. Configure Settings ownership belongs
 * to AI Dungeon Master; registering this shortcut never downloads anything. */
export function registerDotTunnelSetupButton(getClient: () => DotTunnelSetupClient | undefined): void {
  Hooks.on("renderSettings", (_app: unknown, html: unknown) => {
    if (!game.user?.isGM || game.user.name?.toLowerCase() === "tv") return;
    const root = html instanceof HTMLElement ? html : (html as { 0?: HTMLElement } | undefined)?.[0];
    if (!root || root.querySelector("[data-foundry-dot-tunnel-setup]")) return;
    const button = document.createElement("button"); button.type = "button"; button.dataset.foundryDotTunnelSetup = "true"; button.textContent = "Tunnel configuration";
    button.addEventListener("click", () => { const client = getClient(); if (client) void showDotTunnelSetup(client); else ui.notifications.notify("Foundry companion is not connected. Reconnect the GM browser first.", "warning"); });
    (root.querySelector(".settings-list") ?? root).append(button);
  });
}
