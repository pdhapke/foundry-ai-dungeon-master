import {
  AutomaticTriggers,
  isBridgeMutation,
  onAutomaticEventsCancelled,
  type AutomaticSignal,
} from "./automatic-triggers.js";
import { AiDungeonMasterApplication } from "./application.js";
import type { ChatKitTrigger } from "./chatkit-context.js";
import { aiDmController } from "./controller.js";
import { RegionMutationOrigins } from "./mutation-origin.js";
import {
  completedPlayerTurn,
  snapshotCombatTurn,
  type CombatTurnSnapshot,
  type CompletedPlayerTurn,
} from "./completed-player-turn.js";
import {
  DmEventAdapter,
  type DmEventAdapterDependencies,
  type DotTurnState,
} from "./dm-event-adapter.js";
const regionMutationOrigins = new RegionMutationOrigins();

export interface SceneControlTool {
  name: string;
  title: string;
  icon: string;
  button: true;
  order: number;
  onChange: () => void;
}
export function addAiDungeonMasterSceneControl(controls: unknown): void {
  if (currentUser()?.isGM !== true) return;
  const tool: SceneControlTool = {
    name: "ai-dungeon-master",
    title: "AI Dungeon Master",
    icon: "fas fa-dragon",
    button: true,
    order: 90,
    onChange: () => void AiDungeonMasterApplication.open(),
  };
  if (Array.isArray(controls)) {
    const token = (controls as Array<{ name?: string; tools?: SceneControlTool[] }>).find(
      (c) => c.name === "token",
    );
    if (token?.tools && !token.tools.some((t) => t.name === tool.name)) token.tools.push(tool);
  } else if (controls && typeof controls === "object") {
    const token = (
      controls as Record<string, { tools?: Record<string, unknown> | SceneControlTool[] }>
    )["tokens"];
    if (Array.isArray(token?.tools)) {
      if (!token.tools.some((t) => t.name === tool.name)) token.tools.push(tool);
    } else if (token?.tools) token.tools[tool.name] = tool;
  }
}
const MODULE_ID = "foundry-ai-dungeon-master";
interface User {
  id: string;
  isGM: boolean;
  active?: boolean;
}
/** Foundry has no selected user during init; readiness must never imply GM authority. */
const currentUser = (): User | null | undefined => (game as unknown as { user?: User | null }).user;
interface Token {
  id: string;
  parent?: { id: string };
  actor?: { hasPlayerOwner?: boolean };
  hidden?: boolean;
  x?: number;
  y?: number;
  elevation?: number;
  _stats?: { modifiedTime?: number };
  movement?: { id?: string };
}
interface Region {
  id: string;
  hidden?: boolean;
  parent?: { id: string };
}
interface RegionSystem {
  key?: string;
  region?: Region;
  parent?: { disabled?: boolean };
}
interface RegionEvent {
  user: User;
  region: Region;
  data: { token: Token; movement?: { id?: string } | null };
}
interface Wall {
  id: string;
  parent?: { id: string };
  door?: number;
  ds?: number;
  _stats?: { modifiedTime?: number };
}
interface Combatant {
  id: string;
  actor?: { hasPlayerOwner?: boolean };
}
interface Combat {
  id: string;
  scene?: { id: string } | string;
  active?: boolean;
  round?: number;
  turn?: number;
  turns?: Combatant[];
  _stats?: { modifiedTime?: number };
}
interface ObservationOptions {
  foundryLocalApiOrigin?: AutomaticSignal["bridgeOrigin"];
  aiDmOrigin?: unknown;
}
interface Collections {
  users?: { get(id: string): User | undefined };
  scenes?: Iterable<{ id: string; walls?: Iterable<Wall> }>;
  combats?: Iterable<Combat>;
  paused?: boolean;
}
/** Supported installed Foundry RegionBehavior extension, not a vendor patch or generic token-move hook. */
export function registerKeyedRegionBehavior(accept: (signal: AutomaticSignal) => void): boolean {
  const api = foundry as unknown as {
    data?: {
      regionBehaviors?: { RegionBehaviorType?: new () => RegionSystem };
      fields?: { StringField?: new (options: Record<string, unknown>) => unknown };
    };
  };
  const config = (
    globalThis as unknown as {
      CONFIG?: {
        RegionBehavior?: {
          dataModels: Record<string, unknown>;
          typeLabels?: Record<string, string>;
          typeIcons?: Record<string, string>;
        };
      };
    }
  ).CONFIG?.RegionBehavior;
  const Base = api.data?.regionBehaviors?.RegionBehaviorType;
  const StringField = api.data?.fields?.StringField;
  if (!Base || !StringField || !config) return false;
  class KeyedAreaBehavior extends Base {
    static defineSchema() {
      return {
        key: new StringField!({
          required: true,
          blank: true,
          initial: "",
          label: "Campaign area key",
          hint: "Stable canonical resource key; an empty key disables narration.",
        }),
      };
    }
    static events = {
      tokenEnter: function (this: RegionSystem, event: RegionEvent) {
        const token = event.data.token;
        const region = this.region ?? event.region;
        if (
          this.parent?.disabled ||
          region.hidden ||
          token.hidden ||
          !token.actor?.hasPlayerOwner ||
          !this.key ||
          !region.parent?.id ||
          token.parent?.id !== region.parent.id
        )
          return;
        // A GM moving an actual player-owned token counts for solo play.
        const movement = event.data.movement?.id ?? token.movement?.id ?? "direct";
        const bridgeOrigin = regionMutationOrigins.match(
          game.world?.id ?? "",
          token,
          event.data.movement,
        );
        accept({
          kind: "area",
          worldId: game.world?.id ?? "",
          sceneId: region.parent.id,
          documentId: token.id,
          tokenId: token.id,
          regionId: region.id,
          key: this.key,
          revision: token._stats?.modifiedTime ?? -1,
          ...(bridgeOrigin ? { bridgeOrigin } : {}),
          transition: JSON.stringify([
            movement,
            token.x ?? null,
            token.y ?? null,
            token.elevation ?? null,
            event.user.id,
          ]),
        });
      },
    };
  }
  config.dataModels[`${MODULE_ID}.keyedArea`] = KeyedAreaBehavior;
  if (config.typeLabels) config.typeLabels[`${MODULE_ID}.keyedArea`] = "AI DM keyed area entry";
  if (config.typeIcons) config.typeIcons[`${MODULE_ID}.keyedArea`] = "fa-solid fa-dragon";
  return true;
}
let registered = false;
/** Internal seam for the acknowledged local-api bridge and synthetic hook tests. */
export interface AiDmHookIntegration {
  mode?: DmEventAdapterDependencies["mode"];
  scope?: DmEventAdapterDependencies["scope"];
  submit?: DmEventAdapterDependencies["submit"];
  currentState?: DmEventAdapterDependencies["currentState"];
  onChange?: (listener: () => void) => void;
}
export function registerAiDungeonMasterHooks(integration: AiDmHookIntegration = {}): void {
  if (registered) return;
  registered = true;
  // Diagnostic observations never enqueue a DM turn. The MCP marker is synchronous,
  // scoped to the supported setter, and carries no authority for a later request.
  Hooks.on("pauseGame", (paused: boolean) => {
    const origin = (
      globalThis as unknown as {
        foundryLocalApiPauseOrigin?: { source?: string; worldId?: string; correlationId?: string };
      }
    ).foundryLocalApiPauseOrigin;
    console.info(
      JSON.stringify({
        type: "pause-timing",
        stage: "browser-pause-state-observed",
        observedAt: Date.now(),
        paused,
        worldId: game.world?.id,
        correlationId: origin && origin.worldId === game.world?.id ? origin.correlationId : null,
        origin: origin?.source ?? "unmarked",
      }),
    );
  });
  Hooks.on(
    "foundryLocalApiPauseResult",
    (receipt: { outcome?: string; paused?: unknown; worldId?: string; correlationId?: string }) => {
      if (
        currentUser()?.isGM !== true ||
        receipt.worldId !== game.world?.id ||
        receipt.outcome !== "confirmed" ||
        typeof receipt.paused !== "boolean"
      )
        return;
      ui.notifications.info(receipt.paused ? "Paused." : "Unpaused.");
      console.info(
        JSON.stringify({
          type: "pause-timing",
          stage: "browser-action-notification-issued",
          notificationIssuedAtMs: Date.now(),
          worldId: receipt.worldId,
          correlationId: receipt.correlationId,
          paused: receipt.paused,
        }),
      );
    },
  );
  const mode = () => (integration.mode ? integration.mode() : "embedded");
  const enabled = (signal: AutomaticSignal) => {
    syncLifecycle();
    return (
      mode() === "embedded" &&
      currentUser()?.isGM === true &&
      game.world?.id === signal.worldId &&
      typeof canvas !== "undefined" &&
      canvas?.scene?.id === signal.sceneId &&
      game.settings.get(MODULE_ID, "automaticEventsEnabled") === true &&
      aiDmController.store.state.connection === "connected" &&
      aiDmController.store.state.authenticatedLane === "gm"
    );
  };
  const automatic = new AutomaticTriggers(
    (request, signal) => {
      void AiDungeonMasterApplication.open()
        .trigger(request, signal)
        .catch((error) => {
          if (!signal.aborted)
            ui.notifications.error(
              error instanceof Error ? error.message : "Automatic DM response failed.",
            );
        });
    },
    250,
    enabled,
  );
  let currentWorld = game.world?.id;
  const walls = new Map<string, number>();
  const combats = new Map<string, CombatTurnSnapshot>();
  const collections = () => game as unknown as Collections;
  const currentState = (turn: CompletedPlayerTurn): DotTurnState | undefined => {
    if (currentUser()?.isGM !== true) return;
    if (integration.currentState) return integration.currentState(turn);
    const scope = integration.scope?.();
    if (
      !scope ||
      game.world?.id !== scope.worldId ||
      typeof canvas === "undefined" ||
      canvas?.scene?.id !== scope.sceneId ||
      typeof collections().paused !== "boolean"
    )
      return;
    const combat = Array.from(collections().combats ?? []).find(
      (entry) => entry.id === turn.signal.documentId,
    );
    const sceneId = typeof combat?.scene === "string" ? combat.scene : combat?.scene?.id;
    if (
      !combat ||
      combat.active !== true ||
      sceneId !== scope.sceneId ||
      combat._stats?.modifiedTime === undefined ||
      combat.round === undefined ||
      combat.turn === undefined ||
      !combat.turns
    )
      return;
    return {
      worldId: scope.worldId,
      sessionId: scope.sessionId,
      controllerId: scope.controllerId,
      sceneId: scope.sceneId,
      combatId: combat.id,
      combatModifiedTime: combat._stats.modifiedTime,
      round: combat.round,
      turn: combat.turn,
      combatantIds: combat.turns.map((entry) => entry.id),
      paused: collections().paused!,
    };
  };
  const adapter = new DmEventAdapter({
    mode,
    embedded: (signal) => automatic.accept(signal),
    scope: () => {
      if (currentUser()?.isGM !== true) return;
      const scope = integration.scope?.();
      if (
        !scope ||
        game.world?.id !== scope.worldId ||
        typeof canvas === "undefined" ||
        canvas?.scene?.id !== scope.sceneId
      )
        return;
      return {
        ...scope,
        automaticEventsEnabled:
          scope.automaticEventsEnabled === true &&
          game.settings.get(MODULE_ID, "automaticEventsEnabled") === true,
      };
    },
    currentState,
    submit: (input, cancellation) =>
      integration.submit
        ? integration.submit(input, cancellation)
        : Promise.reject(new Error("Acknowledged dot bridge ingress is unavailable.")),
  });
  let lifecycleVersion = 0;
  const cancelWork = () => {
    lifecycleVersion++;
    automatic.cancel();
    adapter.cancel();
    regionMutationOrigins.clear();
  };
  const lifecycleIdentity = () => {
    const user = currentUser();
    const scope = user?.isGM === true ? integration.scope?.() : undefined;
    return JSON.stringify([
      mode(),
      game.world?.id,
      typeof canvas === "undefined" ? null : canvas?.scene?.id,
      user?.id ?? null,
      user?.isGM === true,
      game.settings.get(MODULE_ID, "automaticEventsEnabled"),
      scope?.worldId,
      scope?.sessionId,
      scope?.controllerId,
      scope?.sceneId,
      scope?.connected,
      scope?.isController,
    ]);
  };
  let currentLifecycle = lifecycleIdentity();
  const initialize = () => {
    walls.clear();
    combats.clear();
    for (const scene of collections().scenes ?? [])
      for (const wall of scene.walls ?? []) walls.set(`${scene.id}/${wall.id}`, wall.ds ?? 0);
    for (const combat of collections().combats ?? [])
      combats.set(combat.id, snapshotCombatTurn(combat));
  };
  const lifecycle = () => {
    cancelWork();
    currentLifecycle = lifecycleIdentity();
    initialize();
    if (currentWorld !== game.world?.id) {
      currentWorld = game.world?.id;
      AiDungeonMasterApplication.cancelOpen();
    }
  };
  const syncLifecycle = () => {
    if (currentLifecycle !== lifecycleIdentity()) lifecycle();
  };
  onAutomaticEventsCancelled(lifecycle);
  integration.onChange?.(lifecycle);
  const accept = (signal: AutomaticSignal) => {
    syncLifecycle();
    if (mode() === "embedded") automatic.accept(signal);
  };
  registerKeyedRegionBehavior(accept);
  Hooks.on("ready", lifecycle);
  Hooks.on("canvasReady", lifecycle);
  Hooks.on("canvasTearDown", lifecycle);
  Hooks.on("disconnect", lifecycle);
  Hooks.on("updateSetting", (setting: { key?: string }) => {
    if (
      setting.key === `${MODULE_ID}.automaticEventsEnabled` ||
      setting.key === `${MODULE_ID}.dmEventMode`
    ) {
      lifecycle();
    }
  });
  aiDmController.store.subscribe(() => {
    if (mode() === "embedded" && aiDmController.store.state.connection !== "connected")
      cancelWork();
    syncLifecycle();
  });
  const observeTokenOrigin = (token: Token, change: unknown, options: unknown) => {
    syncLifecycle();
    regionMutationOrigins.observe(game.world?.id ?? "", token, change, options);
  };
  Hooks.on("preUpdateToken", observeTokenOrigin);
  Hooks.on("updateToken", observeTokenOrigin);
  Hooks.on("foundry-ai-dungeon-master.keyedAreaEntered", (signal: AutomaticSignal) =>
    accept({ ...signal, kind: "area" }),
  );
  Hooks.on("createWall", (wall: Wall) => {
    if (wall.parent?.id) walls.set(`${wall.parent.id}/${wall.id}`, wall.ds ?? 0);
  });
  Hooks.on("deleteWall", (wall: Wall) => {
    walls.delete(`${wall.parent?.id}/${wall.id}`);
  });
  Hooks.on("preUpdateWall", (wall: Wall) => {
    if (wall.parent?.id && !walls.has(`${wall.parent.id}/${wall.id}`))
      walls.set(`${wall.parent.id}/${wall.id}`, wall.ds ?? 0);
  });
  Hooks.on(
    "updateWall",
    (wall: Wall, change: { ds?: number }, options: ObservationOptions, userId: string) => {
      syncLifecycle();
      const sceneId = wall.parent?.id;
      if (!sceneId) return;
      const key = `${sceneId}/${wall.id}`;
      const previous = walls.get(key);
      walls.set(key, wall.ds ?? change.ds ?? 0);
      if (
        change.ds !== 1 ||
        previous !== 0 ||
        wall.door === 0 ||
        !wall.door ||
        isBridgeMutation(options?.foundryLocalApiOrigin)
      )
        return;
      const user = collections().users?.get(userId);
      if (!user) return;
      // GM-operated doors qualify only when a player-owned token is in the scene.
      const activeCanvas = typeof canvas === "undefined" ? undefined : canvas;
      const hasPlayer =
        activeCanvas?.scene?.id === sceneId &&
        (
          activeCanvas?.tokens?.placeables as unknown as Array<{ document?: Token }> | undefined
        )?.some((token) => token.document?.actor?.hasPlayerOwner === true);
      if (user.isGM && !hasPlayer) return;
      accept({
        kind: "door",
        worldId: game.world?.id ?? "",
        sceneId,
        documentId: wall.id,
        revision: wall._stats?.modifiedTime ?? -1,
        transition: JSON.stringify([previous, 1, userId]),
      });
    },
  );
  Hooks.on("createCombat", (combat: Combat) => combats.set(combat.id, snapshotCombatTurn(combat)));
  Hooks.on("deleteCombat", (combat: Combat) => combats.delete(combat.id));
  Hooks.on("updateCombat", (combat: Combat, _change: unknown, options: ObservationOptions) => {
    syncLifecycle();
    const previous = combats.get(combat.id);
    const next = snapshotCombatTurn(combat);
    combats.set(combat.id, next);
    const turn = completedPlayerTurn(game.world?.id ?? "", combat, previous, {
      bridgeOrigin: options?.foundryLocalApiOrigin,
    });
    if (!turn) return;
    const version = lifecycleVersion;
    void adapter.accept(turn).then((result) => {
      if (version !== lifecycleVersion) return;
      if (result.status === "failed") ui.notifications.error("Automatic DM event handoff failed.");
      if (result.status === "capacity")
        ui.notifications.error("Automatic DM event capacity reached.");
    });
  });
  Hooks.on("getSceneControlButtons", addAiDungeonMasterSceneControl);
  Hooks.on("chatMessage", (_chatLog: unknown, message: string) => {
    message = normalizeChatCommand(message);
    const control = message.match(/^\/ai-control\s+(.+)$/i);
    if (control) {
      if (currentUser()?.isGM !== true) {
        ui.notifications.warn("AI Dungeon Master currently requires a GM.");
        return false;
      }
      void AiDungeonMasterApplication.open()
        .directControl(control[1]!)
        .catch((error) =>
          ui.notifications.error(
            error instanceof Error ? error.message : "Control request failed.",
          ),
        );
      return false;
    }
    const match = message.match(/^\/ai(?:\s+([\s\S]+))?$/i);
    if (!match) return true;
    if (currentUser()?.isGM !== true) {
      ui.notifications.warn("AI Dungeon Master currently requires a GM.");
      return false;
    }
    const application = AiDungeonMasterApplication.open();
    if (match[1])
      void application
        .trigger({ prompt: match[1] })
        .catch((error) =>
          ui.notifications.error(
            error instanceof Error ? error.message : "ChatKit request failed.",
          ),
        );
    return false;
  });
  // One explicit application event; no inferred game-event loops or automatic retries.
  Hooks.on("foundry-ai-dungeon-master.trigger", (request: ChatKitTrigger) => {
    void AiDungeonMasterApplication.open()
      .trigger(request)
      .catch((error) =>
        ui.notifications.error(error instanceof Error ? error.message : "ChatKit trigger failed."),
      );
  });
}
import { normalizeChatCommand } from "./core-command.js";
