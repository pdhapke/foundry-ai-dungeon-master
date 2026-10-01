/** Selected opt-in signals only. Revision is required for cross-client durable identity. */
export interface AutomaticSignal {
  kind: "area" | "door" | "turn";
  documentId: string;
  revision: number;
  key?: string;
  origin?: string | undefined;
}
export class AutomaticTriggers {
  readonly #pending = new Map<
    string,
    { signal: AutomaticSignal; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    readonly dispatch: (request: { prompt: string; requestId: string }) => void,
    readonly delay = 250,
  ) {}
  accept(signal: AutomaticSignal): void {
    if (
      signal.origin === "ai-dungeon-master" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(signal.documentId) ||
      !Number.isSafeInteger(signal.revision) ||
      signal.revision < 0
    )
      return;
    if (signal.kind === "area" && (!signal.key || !/^[A-Za-z0-9_-]{1,48}$/.test(signal.key)))
      return;
    const slot = `${signal.kind}-${signal.documentId}`;
    const old = this.#pending.get(slot);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      this.#pending.delete(slot);
      this.dispatch({
        requestId: `${slot}-${signal.revision}`,
        prompt:
          signal.kind === "area"
            ? `A player entered keyed area ${signal.key}. Retrieve the relevant campaign section and narrate only observable information.`
            : signal.kind === "door"
              ? "A player opened this scene's door. Describe observable consequences using current authorized state."
              : "A player completed a combat turn. Review current combat state and describe the next situation without inventing actions or rolls.",
      });
    }, this.delay);
    this.#pending.set(slot, { signal, timer });
  }
  cancel(): void {
    for (const value of this.#pending.values()) clearTimeout(value.timer);
    this.#pending.clear();
  }
}
