import assert from "node:assert/strict";
import test from "node:test";
import { registerAiDmApiExtension } from "./api-extension-registration.mjs";

test("AI-owned registration precedes API spawn and restores its parent's environment", () => {
  const environment = {};
  const entry = new URL("file:///C:/synthetic/ai/server/dist/dot-extension.js");
  const restore = registerAiDmApiExtension(environment, { entry, entryExists: () => true });
  const childEnvironment = { ...environment };
  restore();
  assert.deepEqual(environment, {});
  assert.deepEqual(JSON.parse(childEnvironment.FOUNDRY_API_EXTENSIONS), [entry.href]);
});

test("registration preserves other extensions and deduplicates its own descriptor", () => {
  const entry = new URL("file:///C:/synthetic/ai/server/dist/dot-extension.js");
  const previous = JSON.stringify(["file:///C:/synthetic/other.js", entry.href]);
  const environment = { FOUNDRY_API_EXTENSIONS: previous };
  const restore = registerAiDmApiExtension(environment, { entry, entryExists: () => true });
  assert.deepEqual(JSON.parse(environment.FOUNDRY_API_EXTENSIONS), JSON.parse(previous));
  restore();
  assert.equal(environment.FOUNDRY_API_EXTENSIONS, previous);
});

test("missing build or malformed extension configuration fails before changing environment", () => {
  for (const raw of ["{", "{}", "[3]"]) {
    const environment = { FOUNDRY_API_EXTENSIONS: raw };
    assert.throws(() => registerAiDmApiExtension(environment, { entryExists: () => true }), /CONFIGURATION_INVALID/);
    assert.equal(environment.FOUNDRY_API_EXTENSIONS, raw);
  }
  const environment = {};
  assert.throws(() => registerAiDmApiExtension(environment, { entryExists: () => false }), /BUILD_REQUIRED/);
  assert.deepEqual(environment, {});
});
