import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NativePreparationReviewPackage, NativeReviewAuthority } from "./native-adapter.js";
import type { PreparationCaller } from "./index.js";

type Json = Record<string, unknown>;
export interface NativeStep { id: string; toolId: string; args: Json; expectedRevision: string | null; preparationId: string }
export interface NativeStepReceipt { verified: boolean; worldId: string; targetId: string; revision: string; receiptId: string }
export interface NativeCompositionTransport {
  /** Lookup the durable world action before dispatch. Must read back its exact target/revision. */
  recover(step: NativeStep): Promise<NativeStepReceipt | undefined>;
  apply(step: NativeStep): Promise<NativeStepReceipt>;
  inspectScene(sceneId: string): Promise<{ worldId: string; active: boolean; revision: string; preparationId: string }>;
}
export interface NativeCompositionResult {
  packageId: string; packageDigest: string; worldId: string; state: "partial" | "complete"; sceneId?: string;
  steps: { step: NativeStep; receipt?: NativeStepReceipt }[];
  readiness: { map: boolean; population: boolean; visibility: false; trapMechanics: false; liveAccepted: false };
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Durable inactive composition. No secrets are copied into public scene flags or artwork. */
export class DurableNativePreparationComposer {
  constructor(private readonly db: DatabaseSync, private readonly authority: NativeReviewAuthority,
    private readonly transport: NativeCompositionTransport) {
    authority.assertPrivateStorage();
    db.exec("CREATE TABLE IF NOT EXISTS preparation_native_composition(id TEXT PRIMARY KEY, world_id TEXT NOT NULL, state_json TEXT NOT NULL, busy INTEGER NOT NULL DEFAULT 0)");
  }
  private check(caller: PreparationCaller, pkg: NativePreparationReviewPackage, approvalId: string) {
    if (!caller.isGm || caller.worldId !== pkg.worldId || pkg.state !== "reviewed") throw new Error("Preparation unavailable.");
    this.authority.authorize(caller); this.authority.assertPrivateStorage();
    this.authority.authorizeHumanReview(approvalId, pkg.digest);
    const current = this.authority.currentSourceRevisions(caller.worldId);
    for (const [id, revision] of Object.entries(pkg.sourceRevisions))
      if (current[id] !== revision) throw new Error("Stale native preparation sources.");
  }
  status(caller: PreparationCaller, id: string): NativeCompositionResult | undefined {
    if (!caller.isGm) throw new Error("Preparation unavailable.");
    this.authority.authorize(caller); this.authority.assertPrivateStorage();
    const row = this.db.prepare("SELECT state_json FROM preparation_native_composition WHERE id=? AND world_id=?").get(id, caller.worldId);
    return row ? JSON.parse(String(row["state_json"])) : undefined;
  }
  async compose(caller: PreparationCaller, pkg: NativePreparationReviewPackage, approvalId: string): Promise<NativeCompositionResult> {
    this.check(caller, pkg, approvalId);
    const data = structuredClone(pkg.sceneRequest.args.data);
    const tokens = data["tokens"] as Json[]; delete data["tokens"];
    // Never put private record identifiers/notes/traps into a scene readable by a player client.
    data["flags"] = { "foundry-ai-dungeon-master": { preparationId: pkg.id } };
    const initial: NativeCompositionResult = { packageId: pkg.id, packageDigest: pkg.digest, worldId: pkg.worldId, state: "partial",
      steps: [{ step: { id: `prep-${hash([pkg.id, "scene"])}`, toolId: "foundry_create_scene", args: { data }, expectedRevision: null, preparationId: pkg.id } }],
      readiness: { map: false, population: false, visibility: false, trapMechanics: false, liveAccepted: false } };
    this.db.prepare("INSERT OR IGNORE INTO preparation_native_composition(id,world_id,state_json) VALUES(?,?,?)").run(pkg.id, pkg.worldId, JSON.stringify(initial));
    const claim = this.db.prepare("UPDATE preparation_native_composition SET busy=1 WHERE id=? AND world_id=? AND busy=0").run(pkg.id, pkg.worldId);
    if (!claim.changes) throw new Error("Native composition already running.");
    let state = this.status(caller, pkg.id)!;
    const save = () => this.db.prepare("UPDATE preparation_native_composition SET state_json=? WHERE id=? AND world_id=?").run(JSON.stringify(state), pkg.id, pkg.worldId);
    try {
      if (state.packageDigest !== pkg.digest) throw new Error("Native composition package digest changed.");
      state.state = "partial"; state.readiness.population = false; save();
      for (let n = 0; n < state.steps.length; n++) {
        this.check(caller, pkg, approvalId);
        const entry = state.steps[n]!;
        if (entry.receipt) {
          const readback = await this.transport.recover(entry.step);
          if (!readback?.verified || readback.worldId !== pkg.worldId || readback.targetId !== entry.receipt.targetId)
            throw new Error("Completed native step changed or disappeared.");
          this.check(caller, pkg, approvalId);
          entry.receipt = readback; save();
        }
        if (!entry.receipt) {
          const recovered = await this.transport.recover(entry.step);
          // Existing inactive scene is checked before each newly dispatched embedded operation.
          if (state.sceneId && !recovered) {
            const scene = await this.transport.inspectScene(state.sceneId);
            if (scene.worldId !== caller.worldId || scene.active || scene.preparationId !== pkg.id)
              throw new Error("Preparation scene changed or became active.");
          }
          this.check(caller, pkg, approvalId);
          const receipt = recovered ?? await this.transport.apply(entry.step);
          this.check(caller, pkg, approvalId);
          if (!receipt.verified || receipt.worldId !== pkg.worldId) throw new Error("Native step readback failed.");
          entry.receipt = receipt; save();
        }
        if (n === 0 && !state.sceneId) {
          state.sceneId = entry.receipt.targetId;
          state.readiness.map = true;
          for (const [index, token] of tokens.entries()) state.steps.push({ step: {
            id: `prep-${hash([pkg.id, "token", index, token])}`, toolId: "foundry_create_scene_token",
            args: { sceneId: state.sceneId, data: token }, expectedRevision: null, preparationId: pkg.id } });
          save();
        }
      }
      const scene = await this.transport.inspectScene(state.sceneId!);
      this.check(caller, pkg, approvalId);
      if (scene.worldId !== pkg.worldId || scene.active || scene.preparationId !== pkg.id) throw new Error("Final scene readback failed.");
      state.state = "complete"; state.readiness.population = true; save(); return state;
    } finally { this.db.prepare("UPDATE preparation_native_composition SET busy=0 WHERE id=? AND world_id=?").run(pkg.id, pkg.worldId); }
  }
  /** Called only during exclusive startup before accepting requests; interrupted actions recover via receipts. */
  recoverStartup(): void { this.authority.assertPrivateStorage(); this.db.exec("UPDATE preparation_native_composition SET busy=0"); }
}
