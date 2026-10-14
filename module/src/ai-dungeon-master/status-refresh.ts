export interface StatusRefreshOptions {
  cooldownMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
  onFailure?: (error: unknown) => void;
}

/** Event-driven, model-free refresh. The request resolves on the actual status reply.
 * Owns only status requests; never cancels responses, tools, or provider authentication.
 */
export class StatusRefresh {
  #active = false;
  #pending: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastSuccess = -Infinity;
  #generation = 0;
  #dirty = false;
  readonly #now: () => number;
  readonly #schedule: NonNullable<StatusRefreshOptions["schedule"]>;
  readonly #unschedule: NonNullable<StatusRefreshOptions["unschedule"]>;
  readonly #cooldown: number;
  readonly #retryDelays: readonly number[];
  readonly #onFailure: StatusRefreshOptions["onFailure"];

  constructor(
    readonly request: (signal: AbortSignal) => Promise<void>,
    readonly eligible: () => boolean,
    options: StatusRefreshOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? setTimeout;
    this.#unschedule = options.unschedule ?? clearTimeout;
    this.#cooldown = Math.max(0, options.cooldownMs ?? 1000);
    this.#retryDelays = (options.retryDelaysMs ?? [1000, 3000]).slice(0, 2);
    this.#onFailure = options.onFailure;
  }

  open(): Promise<void> {
    this.#active = true;
    return this.refresh();
  }

  close(): void {
    this.#active = false;
    this.#lastSuccess = -Infinity;
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
    this.#pending = null;
    this.#dirty = false;
    this.#clearTimer();
  }

  /** A meaningful change bypasses the success cache, while sharing pending work. */
  invalidate(): Promise<void> {
    this.#lastSuccess = -Infinity;
    if (this.#pending) this.#dirty = true;
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.#active || !this.eligible()) return Promise.resolve();
    if (this.#pending) return this.#pending;
    if (this.#timer !== null) return Promise.resolve();
    if (this.#now() - this.#lastSuccess < this.#cooldown) return Promise.resolve();
    this.#clearTimer();
    return this.#start(0);
  }

  #start(attempt: number): Promise<void> {
    if (!this.#active || !this.eligible()) return Promise.resolve();
    const generation = this.#generation;
    this.#dirty = false;
    const abort = new AbortController();
    this.#abort = abort;
    const pending = new Promise<void>((resolve, reject) => {
      try {
        abort.signal.throwIfAborted();
        resolve(this.request(abort.signal));
      } catch (error) {
        reject(error);
      }
    })
      .then(() => {
        if (generation === this.#generation && !abort.signal.aborted)
          this.#lastSuccess = this.#now();
      })
      .catch((error) => {
        const delay = this.#retryDelays[attempt];
        if (
          generation === this.#generation &&
          !abort.signal.aborted &&
          this.#active &&
          this.eligible() &&
          delay !== undefined
        ) {
          this.#timer = this.#schedule(
            () => {
              this.#timer = null;
              if (generation === this.#generation)
                void this.#start(attempt + 1).catch(() => undefined);
            },
            Math.max(0, delay),
          );
        } else if (
          generation === this.#generation &&
          !abort.signal.aborted &&
          this.#active &&
          this.eligible()
        ) {
          this.#onFailure?.(error);
        }
        throw error;
      })
      .finally(() => {
        if (generation === this.#generation) {
          this.#pending = null;
          this.#abort = null;
          if (this.#dirty && this.#timer === null && this.#active && this.eligible()) {
            void this.#start(0).catch(() => undefined);
          }
        }
      });
    this.#pending = pending;
    return pending;
  }

  #clearTimer(): void {
    if (this.#timer !== null) this.#unschedule(this.#timer);
    this.#timer = null;
  }
}
