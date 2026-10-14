import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assertProtectedCampaignRoot,
  type ProtectedCampaignOptions,
} from "../context/protected-campaign.js";
import type {
  PreparationJob,
  PreparationJobInput,
  PreparationCaller,
  PreparationStage,
  PreparationAreaSource,
  PreparationMapCandidate,
  PreparationPopulationProposal,
} from "../../../shared/dist/preparation/types.js";

export type {
  PreparationJob,
  PreparationJobInput,
  PreparationCaller,
  PreparationStage,
  PreparationAreaSource,
  PreparationMapCandidate,
  PreparationPopulationProposal,
} from "../../../shared/dist/preparation/types.js";
export { auditUniformGrid, geometryMigrationImpact } from "./grid-audit.js";
export { NativePreparationReviewQueue, type NativeReviewAuthority, type NativePreparationReviewPackage } from "./native-adapter.js";
import { auditUniformGrid } from "./grid-audit.js";
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value: string): void => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid preparation identifier.");
};
export interface PreparationJobStore {
  read(id: string): PreparationJob | undefined;
  write(job: PreparationJob, expectedRevision: number | null): void;
}
/** Production durable CAS. SQLite rolls interrupted transactions back on reopen; no file claims.
 * Legacy JSON is read-only and imported once under the same transaction as subsequent edits. */
export class SqlitePreparationJobStore implements PreparationJobStore {
  constructor(private readonly db: DatabaseSync, private readonly legacy?: Pick<PreparationJobStore, "read">) {
    db.exec("CREATE TABLE IF NOT EXISTS preparation_jobs(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, job_json TEXT NOT NULL)");
  }
  private decode(raw: string, key: string): PreparationJob {
    if (Buffer.byteLength(raw) > 256_000) throw new Error("Preparation storage bound exceeded.");
    const job = JSON.parse(raw) as PreparationJob;
    if (job.id !== key || !Number.isInteger(job.revision) || job.revision < 1) throw new Error("Invalid preparation job state.");
    return job;
  }
  private loadOrImport(key: string): PreparationJob | undefined {
    const row = this.db.prepare("SELECT job_json FROM preparation_jobs WHERE id=?").get(key);
    if (row) return this.decode(String(row["job_json"]), key);
    const old = this.legacy?.read(key);
    if (!old) return undefined;
    const raw = JSON.stringify(old); this.decode(raw, key);
    this.db.prepare("INSERT INTO preparation_jobs(id,revision,job_json) VALUES(?,?,?)").run(key, old.revision, raw);
    return old;
  }
  read(key: string): PreparationJob | undefined {
    id(key);
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = this.loadOrImport(key); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  write(job: PreparationJob, expectedRevision: number | null): void {
    id(job.id); const raw = JSON.stringify(job); this.decode(raw, job.id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.loadOrImport(job.id);
      if ((previous?.revision ?? null) !== expectedRevision) throw new Error("Concurrent preparation edit.");
      if (job.revision !== (expectedRevision ?? 0) + 1) throw new Error("Preparation revision must advance once.");
      if (previous) {
        const result = this.db.prepare("UPDATE preparation_jobs SET revision=?,job_json=? WHERE id=? AND revision=?")
          .run(job.revision, raw, job.id, expectedRevision);
        if (!result.changes) throw new Error("Concurrent preparation edit.");
      } else this.db.prepare("INSERT INTO preparation_jobs(id,revision,job_json) VALUES(?,?,?)").run(job.id, job.revision, raw);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
/** Private cross-process compare-and-swap. Exclusive claims are never automatically stolen;
 * a crash-left claim blocks writes until an explicitly reviewed offline recovery. */
export class FilePreparationJobStore implements PreparationJobStore {
  private readonly root: string;
  constructor(private readonly options: ProtectedCampaignOptions) {
    this.root = assertProtectedCampaignRoot(options);
  }
  private path(key: string): string {
    id(key);
    assertProtectedCampaignRoot(this.options);
    const path = join(this.root, `preparation-${key}.json`);
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
      throw new Error("Unsafe preparation storage entry.");
    return path;
  }
  read(key: string): PreparationJob | undefined {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw) > 256_000) throw new Error("Preparation storage bound exceeded.");
    return JSON.parse(raw) as PreparationJob;
  }
  write(job: PreparationJob, expectedRevision: number | null): void {
    const raw = JSON.stringify(job);
    if (Buffer.byteLength(raw) > 256_000) throw new Error("Preparation storage bound exceeded.");
    const target = this.path(job.id), claimPath = `${target}.write-claim`, nonce = randomUUID();
    let claim: number;
    try { claim = openSync(claimPath, "wx", 0o600); }
    catch { throw new Error("Concurrent preparation write or interrupted claim; explicit recovery required."); }
    const claimBody = JSON.stringify({ pid: process.pid, nonce, jobId: job.id });
    const temporary = `${target}.${nonce}.tmp`;
    let temporaryOwned = false;
    try {
      writeFileSync(claim, claimBody);
      const previous = this.read(job.id);
      if ((previous?.revision ?? null) !== expectedRevision) throw new Error("Concurrent preparation edit.");
      this.path(job.id); // Revalidate private root and target before the write.
      writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 }); temporaryOwned = true;
      renameSync(temporary, target); temporaryOwned = false;
    } finally {
      closeSync(claim);
      if (temporaryOwned && existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) unlinkSync(temporary);
      // Remove only the exact claim created by this operation; never delete an old/conflicting claim.
      if (existsSync(claimPath) && !lstatSync(claimPath).isSymbolicLink() && readFileSync(claimPath, "utf8") === claimBody)
        unlinkSync(claimPath);
    }
  }
}
export interface PreparationAuthority {
  /** Must revalidate authenticated GM capability/world binding on every method. */
  authorize(caller: PreparationCaller): void;
  currentSourceRevisions(worldId: string): Record<string, string>;
}
export interface ReviewedNativePreparationAdapter {
  /** Resolve server-held human approval, never trust a model-supplied boolean. Must check approval covers digest. */
  authorizeReview(approvalId: string, job: PreparationJob, areaId: string): void;
  inspect(sceneId: string): {
    worldId: string;
    revision: string;
    active: boolean;
    dedicatedPreparationFixture: boolean;
  };
  /** Atomically compares revision and rechecks inactive fixture status before writing. Must use native system schemas,
   * preserve unrelated/hand-edited entities, actor isolation and idempotencyKey in persistent scene flags/receipts.
   * Existing receipts are returned before checking an obsolete original revision, permitting crash recovery.
   * This adapter MUST NOT activate scenes, move players, start combat, trigger traps or execute generation. */
  apply(input: {
    worldId: string;
    sceneId: string;
    expectedSceneRevision: string;
    idempotencyKey: string;
    area: unknown;
    map: unknown;
    population: unknown;
  }): { sceneId: string; sceneRevision: string; receiptId: string };
  findReceipt(
    idempotencyKey: string,
  ): { sceneId: string; sceneRevision: string; receiptId: string } | undefined;
}
export class PreparationJobService {
  constructor(
    private readonly store: PreparationJobStore,
    private readonly authority: PreparationAuthority,
  ) {}
  private authorize(caller: PreparationCaller): void {
    if (!caller.isGm) throw new Error("Preparation unavailable.");
    this.authority.authorize(caller);
  }
  private load(caller: PreparationCaller, key: string): PreparationJob {
    this.authorize(caller);
    id(key);
    const job = this.store.read(key);
    if (!job || job.input.worldId !== caller.worldId) throw new Error("Preparation unavailable.");
    return job;
  }
  private fresh(job: PreparationJob): void {
    const current = this.authority.currentSourceRevisions(job.input.worldId);
    for (const [key, revision] of Object.entries(job.input.sourceRevisions))
      if (current[key] !== revision)
        throw new Error("Stale preparation sources; start a new reviewed request.");
  }
  create(caller: PreparationCaller, input: PreparationJobInput): PreparationJob {
    this.authorize(caller);
    id(input.worldId);
    id(input.requestId);
    if (
      input.worldId !== caller.worldId ||
      !Number.isInteger(input.maxAreas) ||
      input.maxAreas < 1 ||
      input.maxAreas > 8 ||
      input.areaIds.length < 1 ||
      input.areaIds.length > input.maxAreas ||
      new Set(input.areaIds).size !== input.areaIds.length ||
      Object.keys(input.sourceRevisions).length > 64 ||
      Object.keys(input.sourceRevisions).length < 1 ||
      !["outline", "encounter"].includes(input.depth) ||
      !["records", "map", "population"].includes(input.desiredReadiness)
    )
      throw new Error("Invalid bounded preparation input.");
    input.areaIds.forEach(id);
    for (const [key, revision] of Object.entries(input.sourceRevisions)) {
      id(key);
      if (!revision || revision.length > 128) throw new Error("Invalid source revision.");
    }
    const key = digest([input.worldId, input.requestId]);
    const prior = this.store.read(key);
    if (prior) {
      if (digest(prior.input) !== digest(input))
        throw new Error("Preparation request ID reused with different input.");
      return this.load(caller, key);
    }
    const job: PreparationJob = {
      version: 1,
      id: key,
      input: structuredClone(input),
      revision: 1,
      state: "queued",
      stages: {},
      readiness: {
        records: false,
        map: false,
        population: false,
        visibility: false,
        trapMechanics: false,
        liveAccepted: false,
      },
      warnings: [
        "Private proposals require review and publication; no scene activated.",
        "Generation is unavailable in this deterministic workflow, regardless of a model-supplied budget.",
      ],
      spending: { requests: 0, generationExecuted: false },
    };
    this.fresh(job);
    this.store.write(job, null);
    return structuredClone(job);
  }
  status(caller: PreparationCaller, key: string): PreparationJob {
    return structuredClone(this.load(caller, key));
  }
  cancel(caller: PreparationCaller, key: string): PreparationJob {
    return this.transition(caller, key, "cancelled");
  }
  pause(caller: PreparationCaller, key: string): PreparationJob {
    return this.transition(caller, key, "paused");
  }
  resume(caller: PreparationCaller, key: string): PreparationJob {
    const job = this.load(caller, key);
    this.fresh(job);
    return this.transition(caller, key, "queued");
  }
  private transition(
    caller: PreparationCaller,
    key: string,
    state: PreparationJob["state"],
  ): PreparationJob {
    const job = this.load(caller, key),
      revision = job.revision;
    if (job.state !== state) {
      job.state = state;
      job.revision++;
      this.store.write(job, revision);
    }
    return structuredClone(job);
  }
  private stage(
    caller: PreparationCaller,
    key: string,
    stage: PreparationStage,
    proposals: unknown[],
  ): PreparationJob {
    const job = this.load(caller, key);
    this.fresh(job);
    if (job.state === "paused" || job.state === "cancelled")
      throw new Error("Preparation is not running; explicitly resume.");
    const hash = digest(proposals),
      existing = job.stages[stage];
    if (existing) {
      if (existing.digest !== hash)
        throw new Error("Stage already prepared; new content requires a new request.");
      return structuredClone(job);
    }
    if (Buffer.byteLength(JSON.stringify(proposals)) > 96_000)
      throw new Error("Preparation stage bound exceeded.");
    const revision = job.revision;
    job.stages[stage] = { digest: hash, proposals: structuredClone(proposals) };
    job.readiness[stage === "area" ? "records" : stage] = true;
    job.state = "needs-review";
    job.revision++;
    this.store.write(job, revision);
    return structuredClone(job);
  }
  prepareAreas(
    caller: PreparationCaller,
    key: string,
    sources: PreparationAreaSource[],
  ): PreparationJob {
    const job = this.load(caller, key);
    if (
      sources.length !== job.input.areaIds.length ||
      new Set(sources.map((s) => s.id)).size !== sources.length
    )
      throw new Error("Area scope mismatch.");
    for (const source of sources) {
      if (
        !job.input.areaIds.includes(source.id) ||
        source.revision !== job.input.sourceRevisions[source.id] ||
        source.title.length > 200 ||
        source.travelLinks.length > 16 ||
        source.entryPoints.length > 16 ||
        source.encounterRecordIds.length > 16
      )
        throw new Error("Area provenance or bound mismatch.");
    }
    return this.stage(
      caller,
      key,
      "area",
      sources.map((source) => ({
        ...source,
        status: "proposed",
        visibility: "gm",
        reusedExistingArea: true,
      })),
    );
  }
  prepareMaps(
    caller: PreparationCaller,
    key: string,
    maps: PreparationMapCandidate[],
  ): PreparationJob {
    const job = this.load(caller, key);
    if (
      !job.stages.area ||
      maps.length < 1 ||
      maps.length > job.input.maxAreas ||
      new Set(maps.map((m) => m.areaId)).size !== maps.length
    )
      throw new Error("Prepare bounded areas first.");
    for (const map of maps) {
      if (
        !job.input.areaIds.includes(map.areaId) ||
        !map.source ||
        !map.license ||
        !map.assetRef ||
        ![map.width, map.height, map.grid.size, map.grid.distance].every(
          (n) => Number.isFinite(n) && n > 0,
        ) ||
        ![map.grid.originX, map.grid.originY].every(Number.isFinite) ||
        !Number.isFinite(map.alignmentTolerancePixels) ||
        map.alignmentTolerancePixels < 0 ||
        map.landmarks.length < 3 ||
        map.landmarks.length > 16 ||
        !map.landmarks.every(
          (p) =>
            [p.x, p.y, p.gridColumn, p.gridRow, p.residualPixels].every(Number.isFinite) &&
            p.residualPixels >= 0 &&
            p.residualPixels <= map.alignmentTolerancePixels,
        ) ||
        !["preparation-only", "verified-tv"].includes(map.profile)
      )
        throw new Error("Map provenance/calibration requires review.");
      const audit = auditUniformGrid(
        map.landmarks.map((p) => ({
          artworkX: p.x,
          artworkY: p.y,
          gridColumn: p.gridColumn,
          gridRow: p.gridRow,
        })),
        map.width,
        map.height,
        map.alignmentTolerancePixels,
      );
      if (
        !audit.uniformAlignmentAccepted ||
        Math.abs(audit.uniformSpacing - map.grid.size) > map.alignmentTolerancePixels ||
        Math.abs(audit.originX - map.grid.originX) > map.alignmentTolerancePixels ||
        Math.abs(audit.originY - map.grid.originY) > map.alignmentTolerancePixels
      )
        throw new Error("Measured map calibration does not match proposed native grid.");
    }
    return this.stage(
      caller,
      key,
      "map",
      maps.map((map) => ({
        ...map,
        status: "proposed",
        nativeSceneCreated: false,
        tvAccepted: false,
        reuseRecipe: "battlemap-preparation",
        requiredInterfaces: [
          "dtt_get_status",
          "dtt_pan_battlemap",
          "dtt_scale_battlemap_to_physical",
        ],
        geometryMigration: "requires-review",
      })),
    );
  }
  preparePopulation(
    caller: PreparationCaller,
    key: string,
    proposals: PreparationPopulationProposal[],
  ): PreparationJob {
    const job = this.load(caller, key);
    if (
      !job.stages.map ||
      proposals.length < 1 ||
      proposals.length > job.input.maxAreas ||
      new Set(proposals.map((p) => p.areaId)).size !== proposals.length
    )
      throw new Error("Prepare bounded maps first.");
    const maps = job.stages.map.proposals as PreparationMapCandidate[];
    for (const proposal of proposals) {
      const map = maps.find((m) => m.areaId === proposal.areaId);
      if (
        !map ||
        proposal.tokens.length > 40 ||
        proposal.traps.length > 16 ||
        proposal.gmNoteRecordIds.length > 32 ||
        new Set(proposal.tokens.map((t) => t.preparationId)).size !== proposal.tokens.length
      )
        throw new Error("Population bound/scope mismatch.");
      for (const token of proposal.tokens) {
        id(token.preparationId);
        id(token.actorId);
        id(token.recordId);
        if (
          ![token.x, token.y, token.size].every(Number.isFinite) ||
          token.x < 0 ||
          token.y < 0 ||
          token.size <= 0 ||
          token.x + token.size * map.grid.size > map.width ||
          token.y + token.size * map.grid.size > map.height ||
          typeof token.hidden !== "boolean" ||
          (token.elevation !== undefined && !Number.isFinite(token.elevation)) ||
          (token.disposition !== undefined && ![-1, 0, 1].includes(token.disposition)) ||
          (token.actorLink !== undefined && typeof token.actorLink !== "boolean")
        )
          throw new Error("Invalid staged token footprint.");
      }
      for (const trap of proposal.traps) {
        id(trap.recordId);
        if (
          trap.activation !== "never-during-preparation" ||
          !["manual", "unsupported"].includes(trap.mechanics) ||
          trap.activationState !== "inactive" ||
          !trap.triggerConditions ||
          !trap.detectionConditions ||
          !trap.consequences ||
          !trap.region ||
          !Object.values(trap.region).every(Number.isFinite) ||
          trap.region.width <= 0 ||
          trap.region.height <= 0 ||
          trap.region.x < 0 ||
          trap.region.y < 0 ||
          trap.region.x + trap.region.width > map.width ||
          trap.region.y + trap.region.height > map.height
        )
          throw new Error("Operational trap preparation unsupported.");
      }
      proposal.gmNoteRecordIds.forEach(id);
    }
    return this.stage(
      caller,
      key,
      "population",
      proposals.map((proposal) => ({
        ...proposal,
        visibility: "gm",
        status: "proposed",
        sharedActorsModified: false,
        geometryConfigured: false,
      })),
    );
  }
  applyReviewedDraft(
    caller: PreparationCaller,
    key: string,
    input: { areaId: string; sceneId: string; expectedSceneRevision: string; approvalId: string },
    adapter: ReviewedNativePreparationAdapter,
  ): PreparationJob {
    const job = this.load(caller, key);
    this.fresh(job);
    if (job.state === "cancelled" || job.state === "paused")
      throw new Error("Preparation is not running.");
    id(input.areaId);
    id(input.sceneId);
    if (!input.expectedSceneRevision || !input.approvalId)
      throw new Error("External review and scene revision required.");
    const area = job.stages.area?.proposals.find((p) => (p as { id: string }).id === input.areaId);
    const map = job.stages.map?.proposals.find(
      (p) => (p as { areaId: string }).areaId === input.areaId,
    );
    const population = job.stages.population?.proposals.find(
      (p) => (p as { areaId: string }).areaId === input.areaId,
    );
    if (!area || !map || !population) throw new Error("Draft stages incomplete.");
    adapter.authorizeReview(input.approvalId, structuredClone(job), input.areaId);
    const receiptKey = digest([job.id, input.areaId, input.sceneId, job.stages]);
    const known = job.nativeReceipts?.[receiptKey];
    if (known) return structuredClone(job);
    const recovered = adapter.findReceipt(receiptKey);
    let receipt = recovered;
    if (!receipt) {
      const scene = adapter.inspect(input.sceneId);
      if (
        scene.worldId !== caller.worldId ||
        scene.active ||
        !scene.dedicatedPreparationFixture ||
        scene.revision !== input.expectedSceneRevision
      )
        throw new Error("Scene scope, inactive fixture, or revision mismatch.");
      this.fresh(job);
      receipt = adapter.apply({
        worldId: caller.worldId,
        sceneId: input.sceneId,
        expectedSceneRevision: input.expectedSceneRevision,
        idempotencyKey: receiptKey,
        area: structuredClone(area),
        map: structuredClone(map),
        population: structuredClone(population),
      });
    }
    if (receipt.sceneId !== input.sceneId || !receipt.receiptId || !receipt.sceneRevision)
      throw new Error("Invalid native preparation receipt.");
    const revision = job.revision;
    job.nativeReceipts = { ...job.nativeReceipts, [receiptKey]: receipt };
    job.revision++;
    this.store.write(job, revision);
    return structuredClone(job);
  }
}
