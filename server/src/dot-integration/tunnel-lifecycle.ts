import type { DotIntegration, DotIntegrationSetup } from "./runtime.js";
import type { TunnelController } from "./tunnel-configuration.js";
import type { TunnelHost, TunnelHostHealth, TunnelHostDiagnosticObserver } from "./tunnel-host.js";
import type { TunnelDiagnostics, TunnelDiagnosticAttempt, TunnelDiagnosticDescriptor } from "./tunnel-diagnostics.js";
import { TUNNEL_HOST_FAILURE_CODES, TunnelHostFailure, type TunnelHostFailureCode } from "./tunnel-host.js";

export const lifecycleMessages = {
  inactive: "Tunnel is stopped. Activate requires your explicit confirmation.",
  remediation_required: "Activation is blocked until the local operator confirms managed administrative credential remediation.",
  configuration_unsafe: "Protected configuration, recovery guards, or pinned tools could not be verified. Local review is required.",
  controller_mismatch: "The configured GM, scene, or browser differs from the current scope. Refresh status and review the saved controller.",
  dot_mode_required: "Enable automatic AI DM events and select dot mode explicitly before activation.",
  activation_loaded: "An externally loaded dot service already owns the controller. Stop it through its supported launcher first.",
  running: "The owned tunnel process is running. Local readiness does not confirm a ChatGPT connection or event delivery.",
  host_failed: "The visible tunnel host did not confirm startup or shutdown. Review the visible launcher console before retrying.",
  scope_changed: "The GM connection or activation prerequisites changed. The dot endpoint was revoked and owned tunnel stopped.",
  busy: "Tunnel lifecycle work is pending. Wait, then refresh status.",
} as const;
export type LifecycleReason = keyof typeof lifecycleMessages;
export type LifecycleFailurePhase = "prepare" | "runtime" | "bind" | "revalidate" | "host_start" | "host_health" | "host_shutdown";
const phaseMessages: Record<LifecycleFailurePhase, string> = {
  prepare: "Activation failed while verifying protected configuration or pinned tools. Existing files were preserved.",
  runtime: "Activation failed while opening retained event state. Review protected storage before retrying.",
  bind: "Activation failed while binding the verified GM controller. Refresh the GM connection and scope.",
  revalidate: "Activation prerequisites changed during verification. Refresh status before retrying.",
  host_start: "The owned tunnel host could not confirm startup. Review the fixed host diagnostic before retrying.",
  host_health: "The owned tunnel process did not confirm local readiness. No ChatGPT connection was confirmed.",
  host_shutdown: "The owned host did not confirm shutdown. Another startup remains blocked until cleanup confirms.",
};
export interface TunnelLifecycleStatus {
  phase: "inactive" | "starting" | "running" | "stopping" | "blocked" | "failed";
  canActivate: boolean; canStop: boolean; healthy: boolean | null; ready: boolean | null;
  reason: LifecycleReason; message: string;
  failurePhase?: LifecycleFailurePhase; hostFailureCode?: TunnelHostFailureCode;
  diagnosticId?: string; diagnosticStorage?: "saved" | "unavailable";
}
export interface TunnelActivationPreparation { controller: TunnelController; executable: string; profile: string; setup: DotIntegrationSetup }
export interface TunnelLifecycleDependencies {
  prepare(controller: TunnelController, purpose?: "display" | "activate" | "watch"): Promise<TunnelActivationPreparation>;
  create(setup: DotIntegrationSetup): DotIntegration;
  host(observer?: TunnelHostDiagnosticObserver): TunnelHost;
  diagnostics?: TunnelDiagnostics;
  publish(runtime: DotIntegration | undefined): void;
}
export class TunnelActivationFailure extends Error { constructor(readonly reason: LifecycleReason) { super(lifecycleMessages[reason]); } }
const same = (a: TunnelController, b: TunnelController): boolean => a.worldId === b.worldId && a.sceneId === b.sceneId && a.clientId === b.clientId && a.userId === b.userId;

/** Explicit in-memory lifecycle only. Stopping revokes the route synchronously,
 * cancels pending work, then stops only the owned host and preserves the queue. */
export class TunnelLifecycle {
  private owned: { controller: TunnelController; host: TunnelHost; runtime: DotIntegration; active: boolean; attempt: TunnelDiagnosticAttempt | undefined } | undefined;
  private attempt: TunnelDiagnosticAttempt | undefined;
  private busy = false;
  private closed = false;
  private reason: LifecycleReason = "inactive";
  private phase: TunnelLifecycleStatus["phase"] = "inactive";
  private watch: ReturnType<typeof setTimeout> | undefined;
  private failurePhase: LifecycleFailurePhase | undefined;
  private hostFailureCode: TunnelHostFailureCode | undefined;
  constructor(private readonly dependencies: TunnelLifecycleDependencies) {}
  private record(attempt: TunnelDiagnosticAttempt | undefined, event: unknown): void { try { attempt?.record(event); } catch { /* Diagnostic IO cannot block revocation or cleanup. */ } }
  private finish(attempt: TunnelDiagnosticAttempt | undefined, outcome: "running" | "failed" | "stopped"): void { try { attempt?.finish(outcome); } catch { /* contained */ } }
  private async flush(attempt: TunnelDiagnosticAttempt | undefined): Promise<void> { try { await attempt?.flush(); } catch { /* contained */ } }
  private diagnostic(): TunnelDiagnosticDescriptor | undefined { try { return this.attempt?.descriptor() ?? this.dependencies.diagnostics?.latest(); } catch { return; } }
  private result(controller: TunnelController, health: TunnelHostHealth | undefined, canActivate = false): TunnelLifecycleStatus {
    return { ...this.diagnostic(), phase: this.phase, canActivate, canStop: !!this.owned && same(this.owned.controller, controller) && ["running", "failed"].includes(this.phase),
      healthy: health?.healthy ?? null, ready: health?.ready ?? null, reason: this.reason,
      message: this.failurePhase && ["host_failed", "configuration_unsafe"].includes(this.reason) ? `${phaseMessages[this.failurePhase]}${this.hostFailureCode ? ` Host diagnostic: ${this.hostFailureCode}.` : ""}` : lifecycleMessages[this.reason],
      ...(this.failurePhase ? { failurePhase: this.failurePhase } : {}), ...(this.hostFailureCode ? { hostFailureCode: this.hostFailureCode } : {}) };
  }
  async status(controller: TunnelController): Promise<TunnelLifecycleStatus> {
    try { await this.dependencies.diagnostics?.restore(); } catch { /* Diagnostic reads cannot alter lifecycle authority. */ }
    if (this.closed) return { ...this.result(controller, undefined), canActivate: false, canStop: false, reason: "scope_changed", message: lifecycleMessages.scope_changed };
    if (this.busy) return { ...this.result(controller, undefined), reason: "busy", message: lifecycleMessages.busy };
    if (this.owned) {
      const owned = this.owned;
      if (!same(owned.controller, controller)) return { ...this.result(controller, undefined), reason: "controller_mismatch", message: lifecycleMessages.controller_mismatch };
      try { await this.dependencies.prepare(controller, "display"); if (this.owned !== owned || !owned.active) return this.result(controller, undefined);
        const health = await owned.host.status(); return this.result(controller, this.owned === owned && owned.active ? health : undefined); }
      catch { await this.stopInternal("scope_changed", owned); return this.result(controller, undefined); }
    }
    try { await this.dependencies.prepare(controller, "display"); if (this.phase !== "failed") { this.phase = "inactive"; this.reason = "inactive"; } return this.result(controller, undefined, true); }
    catch (error) { this.phase = "blocked"; this.reason = error instanceof TunnelActivationFailure ? error.reason : "configuration_unsafe"; return this.result(controller, undefined); }
  }
  async activate(controller: TunnelController, stillAuthorized: () => boolean): Promise<TunnelLifecycleStatus> {
    if (this.closed) throw new TunnelActivationFailure("scope_changed");
    if (this.busy || this.owned) throw new TunnelActivationFailure("busy");
    this.busy = true; this.phase = "starting"; this.failurePhase = undefined; this.hostFailureCode = undefined;
    try { this.attempt = this.dependencies.diagnostics?.begin(); } catch { this.attempt = undefined; }
    const attempt = this.attempt;
    let failurePhase: LifecycleFailurePhase = "prepare";
    let phaseStarted = Date.now();
    this.record(attempt, { kind: "phase_start", phase: failurePhase });
    await this.flush(attempt);
    const endPhase = (): void => { this.record(attempt, { kind: "phase_end", phase: failurePhase, durationMs: Math.min(604800000, Math.max(0, Date.now() - phaseStarted)) }); };
    const nextPhase = (phase: LifecycleFailurePhase): void => { endPhase(); failurePhase = phase; phaseStarted = Date.now(); this.record(attempt, { kind: "phase_start", phase }); };
    try {
      const prepared = await this.dependencies.prepare(controller, "activate");
      this.record(attempt, { kind: "validation", phase: "prepare", ok: true });
      if (this.closed || !same(prepared.controller, controller) || !stillAuthorized()) throw new TunnelActivationFailure("scope_changed");
      nextPhase("runtime"); const host = this.dependencies.host(event => this.record(attempt, event));
      const owned = { controller: { ...controller }, host, runtime: undefined as unknown as DotIntegration, active: true, attempt };
      const active = (): boolean => !this.closed && owned.active && stillAuthorized() && prepared.setup.active();
      const setup = { ...prepared.setup, active,
        authenticate: async (...args: Parameters<DotIntegrationSetup["authenticate"]>) => active() ? prepared.setup.authenticate(...args) : null };
      owned.runtime = this.dependencies.create(setup); this.owned = owned;
      host.onExit(() => { if (this.owned === owned && owned.active) this.failurePhase = failurePhase; void this.stopInternal("host_failed", owned); });
      nextPhase("bind");
      if (!await owned.runtime.bind() || !active()) throw new TunnelActivationFailure("scope_changed");
      nextPhase("revalidate");
      const current = await this.dependencies.prepare(controller, "activate");
      if (!same(current.controller, controller) || current.executable !== prepared.executable || current.profile !== prepared.profile || !active()) throw new TunnelActivationFailure("scope_changed");
      this.record(attempt, { kind: "validation", phase: "revalidate", ok: true });
      this.dependencies.publish(owned.runtime); owned.runtime.start();
      nextPhase("host_start"); await this.flush(attempt);
      if (this.closed || this.owned !== owned || !active()) throw new TunnelActivationFailure("scope_changed");
      await host.start(prepared.executable, prepared.profile);
      nextPhase("revalidate"); await this.dependencies.prepare(controller, "activate");
      if (!active()) throw new TunnelActivationFailure("scope_changed");
      this.record(attempt, { kind: "validation", phase: "revalidate", ok: true });
      this.phase = "running"; this.reason = "running";
      nextPhase("host_health"); const health = await host.status();
      this.record(attempt, { kind: "health", healthy: health.healthy, ready: health.ready }); endPhase(); this.finish(attempt, "running");
      await this.flush(attempt);
      if (this.closed || this.owned !== owned || !active()) throw new TunnelActivationFailure("scope_changed");
      this.schedule();
      return this.result(controller, health);
    } catch (error) {
      endPhase();
      if (failurePhase === "prepare" || failurePhase === "revalidate") this.record(attempt, { kind: "validation", phase: failurePhase, ok: false });
      this.failurePhase = failurePhase;
      this.hostFailureCode = error instanceof TunnelHostFailure && TUNNEL_HOST_FAILURE_CODES.includes(error.code) ? error.code : undefined;
      this.record(attempt, { kind: "lifecycle_failure", phase: failurePhase, code: error instanceof TunnelActivationFailure ? error.reason : failurePhase === "prepare" || failurePhase === "runtime" ? "configuration_unsafe" : "host_failed" });
      if (this.hostFailureCode) this.record(attempt, { kind: "failure", code: this.hostFailureCode });
      await this.stopInternal(error instanceof TunnelActivationFailure ? error.reason : failurePhase === "prepare" || failurePhase === "runtime" ? "configuration_unsafe" : "host_failed");
      this.finish(attempt, "failed");
      await this.flush(attempt);
      return this.result(controller, undefined);
    } finally { await this.flush(attempt); this.busy = false; }
  }
  async stop(controller: TunnelController): Promise<TunnelLifecycleStatus> {
    if (this.busy) throw new TunnelActivationFailure("busy");
    if (this.owned && !same(this.owned.controller, controller)) throw new TunnelActivationFailure("controller_mismatch");
    this.busy = true;
    try { await this.stopInternal("inactive"); if (this.reason === "inactive") { this.failurePhase = undefined; this.hostFailureCode = undefined; } await this.flush(this.attempt); return this.result(controller, undefined); }
    finally { await this.flush(this.attempt); this.busy = false; }
  }
  disconnected(clientId: string): void { if (this.owned?.controller.clientId === clientId) void this.stopInternal("scope_changed"); }
  shutdown(): Promise<void> { this.closed = true; return this.stopInternal("inactive"); }
  private stopping: Promise<void> | undefined;
  private stopInternal(reason: LifecycleReason, expected = this.owned): Promise<void> {
    if (this.owned !== expected) return Promise.resolve();
    const owned = this.owned;
    if (this.watch) clearTimeout(this.watch); this.watch = undefined;
    if (owned) owned.active = false;
    this.dependencies.publish(undefined);
    if (this.stopping) return this.stopping;
    const attempt = owned?.attempt ?? this.attempt, started = Date.now();
    this.record(attempt, { kind: "phase_start", phase: "host_shutdown" });
    if (reason !== "inactive") this.record(attempt, { kind: "lifecycle_failure", phase: this.failurePhase ?? "host_health", code: reason });
    this.phase = "stopping";
    const stop = async (): Promise<void> => {
      try {
        if (owned) await Promise.all([owned.runtime.stop(), owned.host.stop()]);
        if (this.owned === owned) this.owned = undefined;
        this.reason = reason; this.phase = reason === "inactive" ? "inactive" : "failed";
      } catch (error) { this.reason = "host_failed"; this.phase = "failed"; this.failurePhase = "host_shutdown"; this.hostFailureCode = error instanceof TunnelHostFailure && TUNNEL_HOST_FAILURE_CODES.includes(error.code) ? error.code : undefined;
        this.record(attempt, { kind: "lifecycle_failure", phase: "host_shutdown", code: "host_failed" }); if (this.hostFailureCode) this.record(attempt, { kind: "failure", code: this.hostFailureCode }); }
      finally { this.record(attempt, { kind: "phase_end", phase: "host_shutdown", durationMs: Math.min(604800000, Math.max(0, Date.now() - started)) }); this.finish(attempt, this.phase === "failed" ? "failed" : "stopped"); }
    };
    this.stopping = stop().finally(() => { this.stopping = undefined; }); return this.stopping;
  }
  private schedule(): void {
    this.watch = setTimeout(() => { this.watch = undefined; const owned = this.owned; if (!owned?.active) return;
      void (async () => { try { await this.dependencies.prepare(owned.controller, "watch"); if (this.owned !== owned || !owned.active) return;
        if (!owned.runtime.setup.active()) throw new Error(); await owned.host.status();
        if (this.owned === owned && owned.active) this.schedule(); }
        catch { await this.stopInternal("scope_changed", owned); } })();
    }, 5000); this.watch.unref();
  }
}
