import assert from "node:assert/strict";
import test from "node:test";
import { validatePreparedScene } from "./prepared-scene-guard.js";

const preparationId = "a".repeat(64);
function createContext() {
  return { input: { family: "scenes", operation: "create", targetId: "scene", preparationGuard: { sceneId: "scene", preparationId } },
    data: { active: false, navigation: false, ownership: { default: 0 }, flags: { "foundry-ai-dungeon-master": { preparationId } } }, source: null };
}
void test("prepared scene creation preserves exact inactive, hidden, owner and preparation policies", () => {
  assert.equal(validatePreparedScene(createContext()), undefined, "guard completes synchronously");
  for (const patch of [{ active: true }, { navigation: true }, { ownership: { default: 1 } }, { ownership: {} }, { flags: {} }, { flags: { "foundry-ai-dungeon-master": { preparationId: "b".repeat(64) } } }]) {
    const value = createContext(); assert.throws(() => validatePreparedScene({ ...value, data: { ...value.data, ...patch } }), /remain inactive/);
  }
});
void test("preparation scope rejects non-scenes, other parents and malformed identities", () => {
  for (const family of ["actors", "items", "scene", "Scene", "journal-pages"]) { const context = createContext(); context.input.family = family; assert.throws(() => validatePreparedScene(context), /scene document/); }
  for (const guard of [{ sceneId: "other", preparationId }, { sceneId: "scene", preparationId: "B".repeat(64) }, { sceneId: "../scene", preparationId }, { sceneId: "scene", preparationId: "a".repeat(63) }]) {
    const context = createContext(); context.input.preparationGuard = guard; assert.throws(() => validatePreparedScene(context), /scope mismatch|Invalid/);
  }
  for (const value of [undefined, null, {}, [], { input: {} }]) assert.throws(() => validatePreparedScene(value), /Invalid/);
});
void test("updates and embedded writes validate the fresh parent source without activating it", () => {
  const source = { active: false, flags: { "foundry-ai-dungeon-master": { preparationId } } };
  for (const family of ["scenes", "scene-tokens", "scene-walls", "scene-tiles"]) {
    const value = { input: { family, operation: "update", parentId: "scene", targetId: "target", preparationGuard: { sceneId: "scene", preparationId } }, data: { name: "prepared" }, source };
    assert.doesNotThrow(() => validatePreparedScene(value));
    assert.throws(() => validatePreparedScene({ ...value, source: { ...source, active: true } }), /active/);
    assert.throws(() => validatePreparedScene({ ...value, source: { active: false, flags: {} } }), /changed/);
    assert.throws(() => validatePreparedScene({ ...value, input: { ...value.input, parentId: "other" } }), /scope mismatch/);
    if (family === "scenes") for (const data of [{ active: true }, { navigation: true }]) assert.throws(() => validatePreparedScene({ ...value, data }), /cannot activate/);
  }
});
