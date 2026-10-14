import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { captureBuildIdentity } from "./build-identity.js";
import { createAiDmApp } from "./app.js";
void it("independent HTTP health retains startup snapshot after on-disk artifact replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "identity-independent-"));
  try {
    mkdirSync(join(root, "server", "dist"), { recursive: true });
    const path = join(root, "server", "dist", "index.js");
    writeFileSync(path, "startup-artifact");
    const snapshot = captureBuildIdentity(root);
    const app = createAiDmApp({
      readiness: () => ({ ready: true, details: {} }),
      buildIdentity: snapshot,
    });
    const before = (
      (await request(app).get("/health")).body as { build: ReturnType<typeof captureBuildIdentity> }
    ).build;
    writeFileSync(path, "later-disk-artifact");
    const after = (
      (await request(app).get("/health")).body as { build: ReturnType<typeof captureBuildIdentity> }
    ).build;
    assert.deepEqual(before, after);
    assert.notEqual(after.manifestDigest, captureBuildIdentity(root).manifestDigest);
    assert.equal(after.artifactHashes["module/dist/index.js"], null);
    assert.match(after.scope, /verify Python health and browser module separately/);
    assert.ok(!JSON.stringify(after).includes(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
