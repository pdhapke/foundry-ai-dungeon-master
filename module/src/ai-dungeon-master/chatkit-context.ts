import type { AiDmChatKitContext, AiDmChatKitTrigger } from "@foundry-ai-dungeon-master/shared";
export type ChatKitContext = AiDmChatKitContext;
export type ChatKitTrigger = AiDmChatKitTrigger;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
function ids(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((v) => typeof v !== "string" || !ID.test(v))
  )
    throw new Error("Game context identifiers are invalid or exceed 20 entries.");
  return [...new Set(value)] as string[];
}
/** Exact allowlist: never copy document bodies, journal text, secrets or arbitrary caller fields. */
export function boundedContext(value: unknown): ChatKitContext {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid game context.");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "sceneId",
    "sceneName",
    "controlledTokenIds",
    "controlledActorIds",
    "targetTokenIds",
    "combatId",
    "round",
    "turn",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error("Unsupported game context field.");
  const output: ChatKitContext = {};
  for (const key of ["sceneId", "combatId"] as const) {
    const item = input[key];
    if (item !== undefined) {
      if (typeof item !== "string" || !ID.test(item)) throw new Error("Invalid game identifier.");
      output[key] = item;
    }
  }
  if (input["sceneName"] !== undefined) {
    if (typeof input["sceneName"] !== "string" || input["sceneName"].length > 200)
      throw new Error("Scene name is too long.");
    output.sceneName = input["sceneName"];
  }
  for (const key of ["controlledTokenIds", "controlledActorIds", "targetTokenIds"] as const) {
    const result = ids(input[key]);
    if (result !== undefined) output[key] = result;
  }
  for (const key of ["round", "turn"] as const) {
    const item = input[key];
    if (item !== undefined) {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item < -1 || item > 100000)
        throw new Error("Invalid combat value.");
      output[key] = item;
    }
  }
  return output;
}
export function currentGameContext(): ChatKitContext {
  if (!game.user.isGM) throw new Error("ChatKit currently requires a Foundry GM.");
  const currentCanvas = typeof canvas === "undefined" ? undefined : canvas;
  const controlled = currentCanvas?.tokens?.controlled ?? [];
  const combat = (game as unknown as { combat?: { id?: string; round?: number; turn?: number } })
    .combat;
  return boundedContext({
    ...(currentCanvas?.scene?.id ? { sceneId: currentCanvas.scene.id } : {}),
    ...((currentCanvas?.scene as { name?: string } | undefined)?.name
      ? { sceneName: (currentCanvas?.scene as { name?: string }).name }
      : {}),
    controlledTokenIds: controlled.flatMap((t) => t.document?.id ?? t.id ?? []).slice(0, 20),
    controlledActorIds: controlled.flatMap((t) => t.document?.actorId ?? []).slice(0, 20),
    targetTokenIds: (currentCanvas?.tokens?.placeables ?? [])
      .filter((t) => t.isTargeted)
      .flatMap((t) => t.id ?? [])
      .slice(0, 20),
    ...(combat?.id ? { combatId: combat.id } : {}),
    ...(combat?.round !== undefined ? { round: combat.round } : {}),
    ...(combat?.turn !== undefined ? { turn: combat.turn } : {}),
  });
}

export class TriggerGuard {
  busy = false;
  readonly #seen = new Map<string, number>();
  start(id: string, now = Date.now()): boolean {
    if (!ID.test(id)) throw new Error("Invalid trigger request ID.");
    for (const [key, time] of this.#seen) if (now - time > 300000) this.#seen.delete(key);
    if (this.#seen.has(id)) return false;
    if (this.busy)
      throw new Error("A response is already running. Cancel it or wait for completion.");
    this.busy = true;
    this.#seen.set(id, now);
    if (this.#seen.size > 100) this.#seen.delete(this.#seen.keys().next().value!);
    return true;
  }
  finish(): void {
    this.busy = false;
  }
}
