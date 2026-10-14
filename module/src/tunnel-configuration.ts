export interface TunnelController { worldId: string; sceneId: string; clientId: string; userId: string }
export const TUNNEL_FAILURE_PHASES = ["prepare", "runtime", "bind", "revalidate", "host_start", "host_health", "host_shutdown"] as const;
export const TUNNEL_HOST_DIAGNOSTIC_CODES = ["host_failed", "visible_console_required", "invalid_path", "invalid_executable", "native_compile_failed", "health_listener_failed", "health_port_occupied", "job_create_failed", "job_limits_failed", "nul_handle_failed", "attribute_list_failed", "handle_list_failed", "process_create_failed", "job_assign_failed", "process_resume_failed", "control_input_invalid", "child_exited", "host_spawn_failed", "host_protocol_invalid", "host_start_timeout", "host_status_timeout", "host_shutdown_unconfirmed"] as const;
export interface TunnelConfigurationStatus {
  configured: boolean; runtimeKeyConfigured: boolean; bridgeKeyConfigured: boolean;
  tunnelId?: string; controller: TunnelController; activation: "inactive" | "active"; message: string;
  lifecycle?: { phase: "inactive" | "starting" | "running" | "stopping" | "blocked" | "failed";
    canActivate: boolean; canStop: boolean; healthy: boolean | null; ready: boolean | null; reason: string; message: string;
    failurePhase?: typeof TUNNEL_FAILURE_PHASES[number]; hostFailureCode?: typeof TUNNEL_HOST_DIAGNOSTIC_CODES[number];
    diagnosticId?: string; diagnosticStorage?: "saved" | "unavailable" };
}
export interface TunnelConfigurationInput { action: "status" | "save" | "activate" | "stop"; confirmed?: true; tunnelId?: string; runtimeKey?: string; rotateRuntimeKey?: true; expectedController?: TunnelController }
// Save keeps fresh ACL checks around every mutation; read-only status/profile
// checks are batched. Each verifier may take 10s. Keep the bounded pending ID
// until that work can finish, without
// retrying or retaining a request/key during the wait.
export const CONFIGURATION_TIMEOUT_MS = { status: 180000, save: 360000, activate: 360000, stop: 180000 } as const;
const errorMessages = {
  invalid_input: "Configuration input is invalid. Use the supplied tunnel ID and a 20–4096 character runtime key with no spaces or line breaks.",
  private_storage_unavailable: "Protected tunnel storage could not be verified. Ask the local operator to check the folder and private permissions.",
  profile_conflict: "The existing tunnel profile differs from the supported profile. It was preserved; local operator review is required.",
  recovery_required: "An interrupted configuration save requires local review. The recovery marker was preserved; do not enter another key.",
  controller_mismatch: "The saved controller belongs to another GM, scene, or browser. Existing configuration was preserved; local operator review is required.",
  replacement_required: "A runtime key is already saved. Leave the key field blank to keep it, or explicitly confirm replacement.",
  runtime_key_required: "No runtime key is saved. Enter the OpenAI tunnel runtime key before saving.",
  rotation_invalid: "Key replacement needs an existing saved key and a new key value.",
  retained_events: "Existing event state requires local review before changing tunnel configuration.",
  bridge_key_conflict: "The existing bridge key and configuration do not match. Both were preserved; local operator review is required.",
  scope_changed: "The displayed GM, scene, or browser scope changed. Refresh status before saving.",
  scope_unavailable: "The current GM scene could not be verified. Check the GM connection and viewed scene, then refresh status.",
  activation_loaded: "Tunnel service configuration is already loaded. Stop it through the supported launcher before changing configuration.",
  busy: "Another configuration request is running. Wait for completion, then refresh status.",
  save_failed: "The save did not complete. Local review of the recovery marker is required before another save.",
} as const;
export class TunnelConfigurationRequestError extends Error {}
/** Write-only keys: never queued, retained with pending requests, logged or
 * stored in Foundry settings/browser storage. A failure needs a fresh UI entry. */
export class TunnelConfigurationClient {
  private pending: { id: string; timer: ReturnType<typeof setTimeout>; resolve(status: TunnelConfigurationStatus): void; reject(error: Error): void } | undefined;
  constructor(private readonly clientId: string, private readonly authority: () => boolean,
    private readonly world: () => string, private readonly sendPrivate: (payload: unknown) => void) {}
  request(input: TunnelConfigurationInput): Promise<TunnelConfigurationStatus> {
    if (!this.authority() || this.pending) { delete input.runtimeKey; return Promise.reject(new Error("Open configuration as the connected local GM and wait for the pending request.")); }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; reject(new TunnelConfigurationRequestError("Configuration result is uncertain. Refresh status before entering another key.")); }, CONFIGURATION_TIMEOUT_MS[input.action]);
      this.pending = { id: requestId, timer, resolve, reject };
      try { this.sendPrivate({ kind: "dot-tunnel-configuration", requestId, worldId: this.world(), ...input }); }
      catch { this.disconnected(); }
      finally { delete input.runtimeKey; }
    });
  }
  receive(raw: unknown): boolean {
    const value = raw as { kind?: string; clientId?: string; requestId?: string; status?: TunnelConfigurationStatus; errorCode?: unknown };
    if (value?.kind !== "dot-tunnel-configuration-status") return false;
    const pending = this.pending;
    if (!pending || value.clientId !== this.clientId || value.requestId !== pending.id) return true;
    const status = value.status;
    clearTimeout(pending.timer); this.pending = undefined;
    if (!status && typeof value.errorCode === "string" && Object.hasOwn(errorMessages, value.errorCode)) {
      pending.reject(new TunnelConfigurationRequestError(errorMessages[value.errorCode as keyof typeof errorMessages])); return true;
    }
    const allowed = ["configured", "runtimeKeyConfigured", "bridgeKeyConfigured", "tunnelId", "controller", "activation", "message", "lifecycle"];
    const lifecycle = status?.lifecycle;
    const hasDiagnosticId = Boolean(lifecycle) && Object.hasOwn(lifecycle!, "diagnosticId");
    const hasDiagnosticStorage = Boolean(lifecycle) && Object.hasOwn(lifecycle!, "diagnosticStorage");
    if (lifecycle && (Object.keys(lifecycle).filter(key => !["failurePhase", "hostFailureCode", "diagnosticId", "diagnosticStorage"].includes(key)).sort().join(",") !== "canActivate,canStop,healthy,message,phase,ready,reason" ||
      !["inactive", "starting", "running", "stopping", "blocked", "failed"].includes(lifecycle.phase) ||
      typeof lifecycle.canActivate !== "boolean" || typeof lifecycle.canStop !== "boolean" ||
      [lifecycle.healthy, lifecycle.ready].some(value => value !== null && typeof value !== "boolean") ||
      !["inactive", "remediation_required", "configuration_unsafe", "controller_mismatch", "dot_mode_required", "activation_loaded", "running", "host_failed", "scope_changed", "busy"].includes(lifecycle.reason) ||
      typeof lifecycle.message !== "string" || lifecycle.message.length > 512 ||
      (lifecycle.failurePhase !== undefined && !TUNNEL_FAILURE_PHASES.includes(lifecycle.failurePhase)) ||
      (lifecycle.hostFailureCode !== undefined && !TUNNEL_HOST_DIAGNOSTIC_CODES.includes(lifecycle.hostFailureCode)) ||
      hasDiagnosticId !== hasDiagnosticStorage ||
      (hasDiagnosticId && (typeof lifecycle.diagnosticId !== "string" || !/^attempt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(lifecycle.diagnosticId) || !["saved", "unavailable"].includes(lifecycle.diagnosticStorage ?? ""))) ||
      (lifecycle.canActivate && !["inactive", "failed"].includes(lifecycle.phase)) || (lifecycle.canStop && !["running", "failed"].includes(lifecycle.phase)))) {
      pending.reject(new TunnelConfigurationRequestError("Tunnel lifecycle status could not be verified.")); return true;
    }
    if (!status || Object.keys(status).some(key => !allowed.includes(key)) || ![status.configured, status.runtimeKeyConfigured, status.bridgeKeyConfigured].every(flag => typeof flag === "boolean") || !(["inactive", "active"].includes(status.activation)) || (status.activation === "active" && lifecycle?.phase !== "running") || typeof status.message !== "string" || status.message.length > 512 || (status.tunnelId !== undefined && !/^tunnel_[a-f0-9]{32}$/.test(status.tunnelId)) || !status.controller || Object.keys(status.controller).sort().join(",") !== "clientId,sceneId,userId,worldId" || Object.values(status.controller).some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || status.controller.clientId !== this.clientId || status.controller.worldId !== this.world()) {
      pending.reject(new TunnelConfigurationRequestError("Configuration was not completed. Check private storage, current GM scope, and key replacement confirmation.")); return true;
    }
    pending.resolve(status); return true;
  }
  disconnected(): void { if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new TunnelConfigurationRequestError("Configuration connection interrupted. Refresh status before entering another key.")); this.pending = undefined; } }
}

export const escapeConfiguration = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function configurationFields(status: TunnelConfigurationStatus): string {
  const scope = status.controller;
  return `<fieldset><legend>Private tunnel configuration</legend><label>Tunnel ID <input name="dot-tunnel-id" type="text" autocomplete="off" spellcheck="false" value="${escapeConfiguration(status.tunnelId ?? "")}"></label><label>OpenAI tunnel runtime key <input name="dot-runtime-key" type="password" autocomplete="new-password" spellcheck="false" value=""></label><p>Runtime key: ${status.runtimeKeyConfigured ? "Configured. Leave blank to keep it." : "Not configured."}</p>${status.runtimeKeyConfigured ? '<label><input name="dot-rotate-key" type="checkbox"> Replace the existing runtime key with the new value</label>' : ""}<p>World: ${escapeConfiguration(scope.worldId)}<br>Scene: ${escapeConfiguration(scope.sceneId)}<br>GM: ${escapeConfiguration(scope.userId)}<br>Controller: ${escapeConfiguration(scope.clientId)}</p><p>${escapeConfiguration(status.message)}</p><p>Save does not activate the tunnel or change AI DM mode.</p></fieldset>`;
}
/** Read and erase the password before creating any asynchronous request. */
export function takeConfigurationInput(root: Pick<HTMLElement, "querySelector">, controller: TunnelController): TunnelConfigurationInput {
  const key = root.querySelector<HTMLInputElement>('[name="dot-runtime-key"]');
  const runtimeKey = key?.value ?? ""; if (key) key.value = "";
  const tunnelId = root.querySelector<HTMLInputElement>('[name="dot-tunnel-id"]')?.value.trim() ?? "";
  const rotate = root.querySelector<HTMLInputElement>('[name="dot-rotate-key"]')?.checked === true;
  return { action: "save", tunnelId, expectedController: { ...controller }, ...(runtimeKey ? { runtimeKey } : {}), ...(rotate ? { rotateRuntimeKey: true } : {}) };
}
