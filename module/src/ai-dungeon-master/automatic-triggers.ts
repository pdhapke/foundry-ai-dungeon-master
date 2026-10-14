import type { ChatKitTrigger } from "./chatkit-context.js";
export interface AutomaticSignal {
  kind: "area" | "door" | "turn";
  worldId: string;
  sceneId: string;
  documentId: string;
  revision: number;
  transition: string;
  tokenId?: string;
  regionId?: string;
  key?: string;
  /** Only structured bridge-produced provenance suppresses events; arbitrary origin strings do not. */
  bridgeOrigin?: { source: string; phase: string; correlationId: string };
}
const id = /^[A-Za-z0-9_-]{1,128}$/;
const lifecycleListeners = new Set<() => void>();
export function onAutomaticEventsCancelled(listener: () => void): void {
  lifecycleListeners.add(listener);
}
export function cancelAutomaticEventLifecycle(): void {
  for (const listener of lifecycleListeners) listener();
}
export function isBridgeMutation(value: unknown): boolean {
  const origin = value as AutomaticSignal["bridgeOrigin"];
  return (
    !!origin &&
    [
      "foundry-local-api.transaction",
      "foundry-local-api.session-action",
      "foundry-local-api.world-document",
    ].includes(origin.source) &&
    ["apply", "compensate"].includes(origin.phase) &&
    typeof origin.correlationId === "string" &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(origin.correlationId)
  );
}
/** Identical events coalesce; distinct Regions/reentries remain distinct. IDs match across observers. */
export class AutomaticTriggers {
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #seen = new Map<string, number>();
  #generation = 0;
  #cancel = new AbortController();
  constructor(
    readonly dispatch: (request: ChatKitTrigger, signal: AbortSignal) => void,
    readonly delay = 250,
    readonly enabled: (signal: AutomaticSignal) => boolean = () => true,
  ) {}
  accept(signal: AutomaticSignal): void {
    if (
      !["area", "door", "turn"].includes(signal.kind) ||
      !id.test(signal.worldId) ||
      !id.test(signal.sceneId) ||
      !id.test(signal.documentId) ||
      !Number.isSafeInteger(signal.revision) ||
      signal.revision < 0 ||
      typeof signal.transition !== "string" ||
      signal.transition.length > 256 ||
      !signal.transition ||
      isBridgeMutation(signal.bridgeOrigin) ||
      !this.enabled(signal)
    )
      return;
    if (
      signal.kind === "area" &&
      (!signal.key ||
        !id.test(signal.key) ||
        !signal.tokenId ||
        !id.test(signal.tokenId) ||
        !signal.regionId ||
        !id.test(signal.regionId))
    )
      return;
    const identity = JSON.stringify([
      signal.kind,
      signal.worldId,
      signal.sceneId,
      signal.documentId,
      signal.tokenId ?? null,
      signal.regionId ?? null,
      signal.key ?? null,
      signal.revision,
      signal.transition,
    ]);
    const now = Date.now();
    for (const [key, time] of this.#seen) if (now - time > 300000) this.#seen.delete(key);
    if (this.#seen.has(identity) || this.#pending.has(identity) || this.#pending.size >= 64) return;
    this.#seen.set(identity, now);
    if (this.#seen.size > 1000) this.#seen.delete(this.#seen.keys().next().value!);
    const generation = this.#generation;
    const cancellation = this.#cancel.signal;
    this.#pending.set(
      identity,
      setTimeout(() => {
        this.#pending.delete(identity);
        if (generation !== this.#generation || cancellation.aborted || !this.enabled(signal))
          return;
        void crypto.subtle
          .digest("SHA-256", new TextEncoder().encode(identity))
          .then((bytes) => {
            if (generation !== this.#generation || cancellation.aborted || !this.enabled(signal))
              return;
            const digest = Array.from(new Uint8Array(bytes), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            this.dispatch(
              {
                requestId: `${signal.kind}-${digest}`,
                prompt:
                  signal.kind === "area"
                    ? `A player entered keyed area ${signal.key}. Retrieve the relevant campaign section and narrate only observable information.`
                    : signal.kind === "door"
                      ? "A player opened this scene's door. Describe observable consequences using current authorized state."
                      : "A player completed a combat turn. Review current combat state and describe the next situation without inventing actions or rolls.",
                context: {
                  sceneId: signal.sceneId,
                  ...(signal.tokenId ? { controlledTokenIds: [signal.tokenId] } : {}),
                },
                automatic: {
                  kind: signal.kind,
                  worldId: signal.worldId,
                  sceneId: signal.sceneId,
                  documentId: signal.documentId,
                  revision: signal.revision,
                  transition: signal.transition,
                  ...(signal.tokenId ? { tokenId: signal.tokenId } : {}),
                  ...(signal.regionId ? { regionId: signal.regionId } : {}),
                  ...(signal.key ? { key: signal.key } : {}),
                },
              },
              cancellation,
            );
          })
          .catch(() => {});
      }, this.delay),
    );
  }
  cancel(): void {
    this.#generation++;
    this.#cancel.abort(new Error("Automatic events cancelled."));
    this.#cancel = new AbortController();
    for (const timer of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
  }
}
