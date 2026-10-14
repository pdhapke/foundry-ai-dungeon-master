import type { AiDmHookIntegration } from "./hooks.js";
import type {
  CompletedPlayerTurnInput,
  DmControllerScope,
  DotTurnState,
} from "./dm-event-adapter.js";

/** AI DM owns this seam; getScope is an acknowledged server-command binding. */
interface DotModuleApi {
  getScope(): (DmControllerScope & { clientId: string; userId: string }) | undefined;
  currentState(combatId: string): DotTurnState | undefined;
  submitCompletedTurn(input: CompletedPlayerTurnInput, cancellation: AbortSignal): Promise<void>;
  onLifecycle(listener: () => void): () => void;
}

const MODULE_ID = "foundry-ai-dungeon-master";

/** No caller identity is supplied, no generic sendEvent, and no extra delivery queue. */
export function createDotHookIntegration(): AiDmHookIntegration {
  let attached: DotModuleApi | undefined;
  let detach: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const api = (): DotModuleApi | undefined => {
    const modules = (
      game as unknown as {
        modules?: { get(id: string): { api?: { dot?: Partial<DotModuleApi> } } | undefined };
      }
    ).modules;
    const candidate = modules?.get(MODULE_ID)?.api?.dot;
    const available =
      candidate &&
      typeof candidate.getScope === "function" &&
      typeof candidate.currentState === "function" &&
      typeof candidate.submitCompletedTurn === "function" &&
      typeof candidate.onLifecycle === "function"
        ? (candidate as DotModuleApi)
        : undefined;
    if (available !== attached) {
      detach?.();
      attached = available;
      detach = attached?.onLifecycle(changed);
      changed();
    }
    return available;
  };
  // AI DM's ready runtime constructs its API. A microtask observes either
  // module loading order without starting a service or an event-delivery timer.
  Hooks.on("ready", () =>
    queueMicrotask(() => {
      api();
    }),
  );
  Hooks.on("foundry-local-api.bridgeReady", () => queueMicrotask(() => { api(); }));
  return {
    mode: () => game.settings.get(MODULE_ID, "dmEventMode"),
    scope: () => {
      const user = (game as unknown as { user?: { id: string; isGM: boolean } | null }).user;
      if (user?.isGM !== true) return;
      const binding = api()?.getScope();
      if (!binding || binding.userId !== user.id) return;
      // isController is supplied only by the acknowledged server-command bridge
      // binding. A browser GM flag alone never selects the dot controller.
      return binding;
    },
    currentState: (turn) => api()?.currentState(turn.signal.documentId),
    submit: (input, cancellation) => {
      const bridge = api();
      if (!bridge)
        return Promise.reject(new Error("Acknowledged dot bridge ingress is unavailable."));
      return bridge.submitCompletedTurn(input, cancellation);
    },
    onChange: (listener) => {
      listeners.add(listener);
      api();
    },
  };
}
