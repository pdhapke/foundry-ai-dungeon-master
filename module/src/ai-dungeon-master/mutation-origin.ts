interface TokenOriginDocument {
  id: string;
  uuid?: string;
  parent?: { id: string };
  x?: number;
  y?: number;
  _stats?: { modifiedTime?: number };
}
export interface SessionMutationOrigin {
  source: "foundry-local-api.session-action" | "foundry-local-api.world-document";
  phase: "apply";
  correlationId: string;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Local operation evidence only. This cache neither grants permission nor infers provenance from IDs. */
export class RegionMutationOrigins {
  private readonly entries = new Map<
    string,
    {
      movement: object;
      movementId: string;
      x: number;
      y: number;
      revision: number;
      origin: SessionMutationOrigin;
      expires: number;
    }
  >();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5000,
    private readonly maximum = 256,
  ) {}
  clear(): void {
    this.entries.clear();
  }
  private key(world: string, token: TokenOriginDocument): string {
    return JSON.stringify([world, token.parent?.id, token.uuid ?? token.id]);
  }
  observe(world: string, token: TokenOriginDocument, change: unknown, options: unknown): void {
    const input = object(change);
    if (!("x" in input || "y" in input)) return;
    const key = this.key(world, token);
    this.entries.delete(key);
    const opts = object(options),
      origin = object(opts["foundryLocalApiOrigin"]),
      api = object(opts["foundryLocalApi"]);
    if (
      !world ||
      !token.parent?.id ||
      !["foundry-local-api.session-action", "foundry-local-api.world-document"].includes(
        String(origin["source"]),
      ) ||
      origin["phase"] !== "apply" ||
      api["authorizedGmMovement"] !== true ||
      typeof origin["correlationId"] !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(origin["correlationId"]) ||
      opts["correlationId"] !== origin["correlationId"]
    )
      return;
    const movement = object(opts["_movement"])[token.id];
    const data = object(movement);
    const x = input["x"] ?? token.x,
      y = input["y"] ?? token.y,
      revision = token._stats?.modifiedTime;
    if (
      !movement ||
      typeof movement !== "object" ||
      typeof data["id"] !== "string" ||
      !data["id"] ||
      !finite(x) ||
      !finite(y) ||
      !Number.isSafeInteger(revision) ||
      revision! < 0
    )
      return;
    this.entries.set(key, {
      movement,
      movementId: data["id"],
      x,
      y,
      revision: revision!,
      origin: {
        source: origin["source"] as SessionMutationOrigin["source"],
        phase: "apply",
        correlationId: origin["correlationId"],
      },
      expires: this.now() + this.ttlMs,
    });
    for (const [id, entry] of this.entries)
      if (entry.expires <= this.now()) this.entries.delete(id);
    while (this.entries.size > this.maximum) this.entries.delete(this.entries.keys().next().value!);
  }
  match(
    world: string,
    token: TokenOriginDocument,
    movement: unknown,
  ): SessionMutationOrigin | undefined {
    const key = this.key(world, token),
      entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.now() || token._stats?.modifiedTime !== entry.revision) {
      this.entries.delete(key);
      return;
    }
    // Installed core passes this very operation object to tokenEnter. An ID or
    // matching coordinates alone cannot suppress a manual or unrelated entry.
    if (
      movement !== entry.movement ||
      object(movement)["id"] !== entry.movementId ||
      token.x !== entry.x ||
      token.y !== entry.y
    )
      return;
    const passed = object(object(movement)["passed"]),
      waypoints = passed["waypoints"];
    if (!Array.isArray(waypoints) || !waypoints.length) return;
    const last = object(waypoints.at(-1));
    if (last["x"] !== entry.x || last["y"] !== entry.y) return;
    return { ...entry.origin };
  }
}
