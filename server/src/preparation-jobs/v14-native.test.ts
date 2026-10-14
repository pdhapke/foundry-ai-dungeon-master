import test from "node:test";
import assert from "node:assert/strict";
import { ExistingWorldDocumentPreparationTransport } from "./world-native-transport.js";
import { worldSourceRevision } from "../chatkit/world-document-actions.js";
import type { NativeStep } from "./durable-native.js";
// Representative v14 Scene.toObject: enumerable levels; no legacy background shim.
// Exact field names/defaults audited from App/common/documents/{scene,level}.mjs.
test("v14 scene readback admits native Level defaults while verifying supplied image/texture fields", async () => {
  const levelId = "0123456789abcdef", prep = "a".repeat(64);
  const step: NativeStep = { id: "prep-scene", toolId: "foundry_create_scene", expectedRevision: null, preparationId: prep,
    args: { data: { active: false, navigation: false, ownership: { default: 0 }, width: 1000, height: 1000, padding: 0,
      shiftX: 0, shiftY: 0, initialLevel: levelId, grid: { type: 1, size: 100, distance: 5, units: "ft" },
      flags: { "foundry-ai-dungeon-master": { preparationId: prep } },
      levels: [{ _id: levelId, name: "Map", background: { src: "approved/map.webp" },
        textures: { anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, fit: "fill", scaleX: 1, scaleY: 1, rotation: 0 } }] } } };
  let source: Record<string, unknown> | null = null;
  let targetId = "";
  const transport = new ExistingWorldDocumentPreparationTransport({ worldId: "world", userId: "gm", authorize: async () => {},
    call: async (name, input) => {
      targetId = String(input["targetId"]);
      if (name === "foundry_apply_world_document") {
        assert.deepEqual(input["preparationGuard"], { sceneId: targetId, preparationId: prep });
        source = structuredClone(input["data"]) as Record<string, unknown>; source["_id"] = targetId;
        const level = (source["levels"] as Record<string, unknown>[])[0]!;
        level["elevation"] = { bottom: 0, top: 20 }; level["sort"] = 0; level["flags"] = {};
        level["foreground"] = { src: null, tint: "#ffffff", alphaThreshold: 0.75 };
        Object.assign(level["background"] as object, { color: "#999999", tint: "#ffffff", alphaThreshold: 0.75 });
      }
      return { worldId: "world", family: "scenes", operation: name === "foundry_apply_world_document" ? "create" : "get",
        targetId, source, revision: worldSourceRevision(source), verified: true, correlationId: step.id, idempotencyKey: step.id };
    } });
  assert.equal((await transport.apply(step)).verified, true);
  assert.equal(Object.hasOwn(source!, "background"), false);
  assert.equal((await transport.recover(step))?.verified, true);
  const level = (source!["levels"] as Record<string, unknown>[])[0]!;
  (level["background"] as Record<string, unknown>)["src"] = "edited.webp";
  await assert.rejects(transport.recover(step), /changed/);
});
