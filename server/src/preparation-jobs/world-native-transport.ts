import { createHash } from "node:crypto";
import { worldSourceRevision } from "../chatkit/world-document-actions.js";
import type { NativeCompositionTransport, NativeStep, NativeStepReceipt } from "./durable-native.js";
export interface PreparationWorldPort {
  worldId: string; userId: string;
  /** Current authenticated GM, exact client/world binding and trusted human request approval. */
  authorize(): Promise<void>;
  /** Existing MCP call with advertised-schema validation and bounded timeout. */
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native source.");
  return value as Record<string, unknown>;
};
function fields(data: Record<string, unknown>, source: Record<string, unknown>): boolean {
  return Object.entries(data).every(([key, value]) => {
    if (key === "levels" && Array.isArray(value)) {
      const actual = source[key];
      return Array.isArray(actual) && actual.length === value.length && value.every(expected => {
        const id = object(expected)["_id"], found = actual.find(v => object(v)["_id"] === id);
        return !!found && fields(object(expected), object(found));
      });
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? fields(object(value), object(source[key])) : JSON.stringify(value) === JSON.stringify(source[key]);
  });
}
/** Uses the supported CAS/idempotent world-document primitives, never raw scene create tools. */
export class ExistingWorldDocumentPreparationTransport implements NativeCompositionTransport {
  constructor(private readonly port: PreparationWorldPort) {}
  private base(step: NativeStep) {
    if (!["foundry_create_scene", "foundry_create_scene_token"].includes(step.toolId)) throw new Error("Unsupported preparation native step.");
    // Server-owned stable ID survives an interrupted action without generating another native entity.
    return { worldId: this.port.worldId, requestingUserId: this.port.userId,
      family: step.toolId === "foundry_create_scene" ? "scenes" : "scene-tokens",
      targetId: createHash("sha256").update(step.id).digest("hex").slice(0, 16),
      ...(step.toolId === "foundry_create_scene_token" ? { parentId: String(step.args["sceneId"]) } : {}) };
  }
  private async read(step: NativeStep) {
    await this.port.authorize(); const base = this.base(step);
    const result = await this.port.call("foundry_get_world_document", { ...base, operation: "get" });
    if (result["worldId"] !== base.worldId || result["family"] !== base.family || result["targetId"] !== base.targetId ||
      result["parentId"] !== ("parentId" in base ? base.parentId : undefined) || worldSourceRevision(result["source"]) !== result["revision"])
      throw new Error("Preparation native readback scope/hash mismatch.");
    await this.port.authorize(); return result;
  }
  private receipt(step: NativeStep, result: Record<string, unknown>): NativeStepReceipt {
    if (!result["source"] || !fields(object(step.args["data"]), object(result["source"]))) throw new Error("Preparation native fields changed.");
    return { verified: true, worldId: this.port.worldId, targetId: String(result["targetId"]),
      revision: String(result["revision"]), receiptId: step.id };
  }
  async recover(step: NativeStep): Promise<NativeStepReceipt | undefined> {
    const result = await this.read(step);
    if (result["source"] === null) return undefined;
    return this.receipt(step, result);
  }
  async apply(step: NativeStep): Promise<NativeStepReceipt> {
    const existing = await this.recover(step); if (existing) return existing;
    await this.port.authorize();
    const result = await this.port.call("foundry_apply_world_document", { ...this.base(step), operation: "create",
      data: step.args["data"], expectedRevision: null, correlationId: step.id, idempotencyKey: step.id, reviewedDestructive: true,
      preparationGuard: { sceneId: step.toolId === "foundry_create_scene" ? this.base(step).targetId : String(step.args["sceneId"]), preparationId: step.preparationId } });
    if (result["verified"] !== true || result["correlationId"] !== step.id || result["idempotencyKey"] !== step.id)
      throw new Error("Preparation native receipt mismatch.");
    const after = await this.read(step);
    if (after["revision"] !== result["revision"]) throw new Error("Preparation native independent readback mismatch.");
    return this.receipt(step, after);
  }
  async inspectScene(sceneId: string) {
    await this.port.authorize();
    const result = await this.port.call("foundry_get_world_document", { worldId: this.port.worldId,
      requestingUserId: this.port.userId, family: "scenes", targetId: sceneId, operation: "get" });
    if (result["worldId"] !== this.port.worldId || result["family"] !== "scenes" || result["targetId"] !== sceneId ||
      worldSourceRevision(result["source"]) !== result["revision"]) throw new Error("Invalid preparation scene readback.");
    const source = object(result["source"]); const flags = object(object(source["flags"])["foundry-ai-dungeon-master"]);
    await this.port.authorize();
    return { worldId: this.port.worldId, active: source["active"] !== false, revision: String(result["revision"]), preparationId: String(flags["preparationId"]) };
  }
}
