export interface PanelReadiness {
  state: "preparing" | "ready" | "reconnect-required";
  message: string;
}
/** A single bounded, zero-inference request; expiry invalidates without a refresh loop. */
export class PanelPreparation {
  #generation = 0;
  #pending: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #expiry: ReturnType<typeof setTimeout> | null = null;
  #validUntil = 0;
  #retryAt = 0;
  constructor(
    readonly request: (signal: AbortSignal) => Promise<Response>,
    readonly publish: (state: PanelReadiness) => void,
    readonly now = Date.now,
  ) {}
  /** Explicit recovery shares a current check instead of aborting a concurrent opener. */
  refresh(): Promise<void> {
    if (this.#pending) return this.#pending;
    this.invalidate();
    return this.ensure();
  }
  invalidate(message = "Reconnect required. Preparation must be checked again."): void {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
    this.#pending = null;
    this.#validUntil = 0;
    this.#retryAt = 0;
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = null;
    this.publish({ state: "reconnect-required", message });
  }
  ensure(): Promise<void> {
    if (this.#pending) return this.#pending;
    if (this.#validUntil > this.now()) return Promise.resolve();
    if (this.#retryAt > this.now()) return Promise.reject(new Error("Reconnect required. Preparation failed; wait briefly before retrying."));
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.publish({ state: "preparing", message: "Preparing credentials and campaign context…" });
    const timeout = setTimeout(() => abort.abort(), 15000);
    const pending = (async () => {
      try {
        const response = await this.request(abort.signal);
        const data: unknown = await response.json();
        if (generation !== this.#generation || abort.signal.aborted) throw new Error("Preparation cancelled.");
        const result = data as { state?: unknown; validUntil?: unknown; retryAfterMs?: unknown; reason?: unknown };
        const validUntil = typeof result.validUntil === "string" ? Date.parse(result.validUntil) : NaN;
        if (!response.ok || result.state !== "ready" || !Number.isFinite(validUntil) || validUntil <= this.now()) {
          this.#retryAt = this.now() + Math.max(1000, Math.min(30000, typeof result.retryAfterMs === "number" ? result.retryAfterMs : 5000));
          const message = result.reason === "context-action-required"
            ? "Reconnect required. Selected model context could not be admitted. Check sidecar availability and model context configuration; no inference was sent."
            : result.reason === "privacy-action-required"
              ? "Reconnect required. Private campaign storage requires repair before readiness. Ask the operator to resolve storage protection blockers."
              : response.status === 401
                ? "Reconnect required. Foundry authentication expired. Reconnect as the current GM."
                : response.status === 403
                  ? "Reconnect required. Campaign preparation requires current Foundry GM authorization."
                  : "Reconnect required. Credentials or campaign preparation could not be checked. Recheck connection or reconnect.";
          throw new Error(message);
        }
        this.#validUntil = validUntil;
        this.publish({ state: "ready", message: "Ready. Credentials and bounded campaign context checked; each action still requires current authorization. Player perception and provider acceptance are checked separately. Private campaign-file protection and player/TV acceptance remain required." });
        this.#expiry = setTimeout(() => {
          this.#expiry = null;
          this.#validUntil = 0;
          this.publish({ state: "reconnect-required", message: "Preparation expired. Refresh status or submit to check prerequisites again." });
        }, Math.min(2147483647, validUntil - this.now()));
      } catch (error) {
        if (generation === this.#generation) {
          this.#retryAt ||= this.now() + 5000;
          this.publish({ state: "reconnect-required", message: error instanceof Error && !abort.signal.aborted ? error.message : "Reconnect required. Preparation was interrupted." });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        if (generation === this.#generation) { this.#pending = null; this.#abort = null; }
      }
    })();
    this.#pending = pending;
    return pending;
  }
}
