import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  PreparationCaller,
  PreparationJob,
  PreparationAreaSource,
  PreparationMapCandidate,
  PreparationPopulationProposal,
} from "./index.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface NativePreparationReviewPackage {
  version: 1;
  id: string;
  worldId: string;
  jobId: string;
  areaId: string;
  inputRevision: number;
  sourceRevisions: Record<string, string>;
  state: "needs-native-contract" | "reviewed";
  sceneRequest: {
    toolId: "foundry_create_scene";
    actionId: string;
    expectedRevision: null;
    args: { data: Record<string, unknown> };
  };
  privateRecordLinks: { gmNoteRecordIds: string[]; trapRecordIds: string[] };
  blockers: string[];
  digest: string;
}
export interface NativeReviewAuthority {
  authorize(caller: PreparationCaller): void;
  assertPrivateStorage(): void;
  currentSourceRevisions(worldId: string): Record<string, string>;
  /** Must resolve exact package digest against a human-issued server-held approval. */
  authorizeHumanReview(approvalId: string, digest: string): void;
}
/** Durable exact private review handoff. Reviewed packages execute through the staged composer,
 * not this legacy dispatch method; ordinary raw create requests may execute immediately. */
export class NativePreparationReviewQueue {
  constructor(
    private readonly db: DatabaseSync,
    private readonly authority: NativeReviewAuthority,
  ) {
    authority.assertPrivateStorage();
    db.exec(
      "CREATE TABLE IF NOT EXISTS preparation_native_review(id TEXT PRIMARY KEY, world_id TEXT NOT NULL, package_json TEXT NOT NULL)",
    );
  }
  private authorize(caller: PreparationCaller) {
    if (!caller.isGm) throw new Error("Preparation unavailable.");
    this.authority.authorize(caller);
    this.authority.assertPrivateStorage();
  }
  private fresh(value: NativePreparationReviewPackage) {
    const current = this.authority.currentSourceRevisions(value.worldId);
    for (const [id, revision] of Object.entries(value.sourceRevisions))
      if (current[id] !== revision) throw new Error("Stale native preparation sources.");
  }
  get(caller: PreparationCaller, id: string): NativePreparationReviewPackage {
    this.authorize(caller);
    const row = this.db
      .prepare("SELECT package_json FROM preparation_native_review WHERE id=? AND world_id=?")
      .get(id, caller.worldId);
    if (!row) throw new Error("Preparation unavailable.");
    return JSON.parse(String(row["package_json"])) as NativePreparationReviewPackage;
  }
  stage(
    caller: PreparationCaller,
    job: PreparationJob,
    areaId: string,
  ): NativePreparationReviewPackage {
    this.authorize(caller);
    if (job.input.worldId !== caller.worldId || job.state === "cancelled" || job.state === "paused")
      throw new Error("Preparation unavailable.");
    const area = job.stages.area?.proposals.find(
      (value) => (value as PreparationAreaSource).id === areaId,
    ) as PreparationAreaSource | undefined;
    const map = job.stages.map?.proposals.find(
      (value) => (value as PreparationMapCandidate).areaId === areaId,
    ) as PreparationMapCandidate | undefined;
    const population = job.stages.population?.proposals.find(
      (value) => (value as PreparationPopulationProposal).areaId === areaId,
    ) as PreparationPopulationProposal | undefined;
    if (!area || !map || !population) throw new Error("Native preparation stages incomplete.");
    if(!/\.(?:png|jpe?g|webp)$/i.test(map.assetRef)||/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/])/.test(map.assetRef)||map.assetRef.includes('\\')||map.assetRef.split('/').some(part=>!part||part==='.'||part==='..'))
      throw new Error('Native preparation requires an authorized local raster artwork reference; remote acquisition needs its separate approved workflow.');
    if (map.grid.originX !== 0 || map.grid.originY !== 0)
      throw new Error("Nonzero artwork grid origin needs supported scene-offset calibration before native preparation.");
    const id = hash([job.id, areaId, job.stages]);
    const levelId = hash([id, "level"]).slice(0, 16);
    const sceneData = {
      name: area.title,
      active: false,
      navigation: false,
      ownership: { default: 0 },
      width: map.width,
      height: map.height,
      initialLevel: levelId,
      levels: [{ _id: levelId, name: "Map", background: { src: map.assetRef },
        textures: { anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, fit: "fill", scaleX: 1, scaleY: 1, rotation: 0 } }],
      shiftX: 0,
      shiftY: 0,
      grid: { type: 1, size: map.grid.size, distance: map.grid.distance, units: map.grid.units },
      padding: 0,
      flags: { "foundry-ai-dungeon-master": { preparationId: id } },
      tokens: population.tokens.map((token) => ({
        actorId: token.actorId,
        actorLink: token.actorLink ?? false,
        x: token.x,
        y: token.y,
        width: token.size,
        height: token.size,
        elevation: token.elevation ?? 0,
        disposition: token.disposition ?? 0,
        hidden: token.hidden,
        flags: { "foundry-ai-dungeon-master": { preparationId: token.preparationId } },
      })),
    };
    const body = {
      version: 1 as const,
      id,
      worldId: caller.worldId,
      jobId: job.id,
      areaId,
      inputRevision: job.revision,
      sourceRevisions: structuredClone(job.input.sourceRevisions),
      state: "needs-native-contract" as const,
      sceneRequest: {
        toolId: "foundry_create_scene" as const,
        actionId: `prep-${id}`,
        expectedRevision: null,
        args: { data: sceneData },
      },
      privateRecordLinks: {
        gmNoteRecordIds: population.gmNoteRecordIds,
        trapRecordIds: population.traps.map((t) => t.recordId),
      },
      blockers: [
        "Execute this reviewed package through durable staged composition, not legacy dispatch; whole-scene atomicity is not required.",
        "Selected-system schemas and final native readback remain enforced by supported document primitives; live visual acceptance remains pending.",
        "Private notes/traps remain in authenticated campaign records; player access to inactive scenes/flags must be independently validated.",
        "Existing world-document request creates can execute immediately; this queue cannot dispatch without a separate authenticated human review workflow.",
      ],
    };
    const value: NativePreparationReviewPackage = { ...body, digest: hash(body) };
    this.fresh(value);
    if (Buffer.byteLength(JSON.stringify(value)) > 128000)
      throw new Error("Native proposal bound exceeded.");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO preparation_native_review(id,world_id,package_json) VALUES(?,?,?)",
      )
      .run(id, caller.worldId, JSON.stringify(value));
    const existing = this.get(caller, id);
    if (existing.digest !== value.digest) throw new Error("Native preparation review conflict.");
    return existing;
  }
  review(
    caller: PreparationCaller,
    id: string,
    approvalId: string,
  ): NativePreparationReviewPackage {
    const value = this.get(caller, id);
    this.fresh(value);
    this.authority.authorizeHumanReview(approvalId, value.digest);
    value.state = "reviewed";
    this.db
      .prepare("UPDATE preparation_native_review SET package_json=? WHERE id=? AND world_id=?")
      .run(JSON.stringify(value), id, caller.worldId);
    return value;
  }
  /** Legacy entry point: use the reviewed durable composer instead. */
  dispatch(caller: PreparationCaller, id: string): never {
    const value = this.get(caller, id);
    this.fresh(value);
    throw new Error(`Native preparation dispatch blocked: ${value.blockers.join(" ")}`);
  }
}
