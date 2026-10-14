import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureBuildIdentity } from "./build-identity.js";

void it("retains startup hashes across disk edits and reports missing artifacts explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-dm-build-"));
  try {
    mkdirSync(join(root, "server", "dist"), { recursive: true });
    const artifact = join(root, "server", "dist", "index.js");
    writeFileSync(artifact, "old startup code");
    const loaded = captureBuildIdentity(root);
    const original = loaded.artifactHashes["server/dist/index.js"];
    writeFileSync(artifact, "new disk code");
    const newer = captureBuildIdentity(root);
    assert.equal(loaded.artifactHashes["server/dist/index.js"], original);
    assert.notEqual(newer.artifactHashes["server/dist/index.js"], original);
    assert.notEqual(newer.manifestDigest, loaded.manifestDigest);
    assert.equal(loaded.artifactHashes["server/dist/chatkit/session-actions.js"], null);
    mkdirSync(join(root, "server", "dist", "chatkit"), { recursive: true });
    writeFileSync(join(root, "server", "dist", "chatkit", "attack-sequences.js"), "sequence implementation");
    const withSequence = captureBuildIdentity(root);
    assert.equal(loaded.artifactHashes["server/dist/chatkit/attack-sequences.js"], null);
    assert.match(withSequence.artifactHashes["server/dist/chatkit/attack-sequences.js"]!, /^[a-f0-9]{64}$/);
    assert.notEqual(withSequence.manifestDigest, newer.manifestDigest);
    assert.ok(!JSON.stringify(loaded).includes(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void it("captures the compiled privacy module and retains explicit missing evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-dm-privacy-identity-"));
  try {
    mkdirSync(join(root, "server", "dist"), { recursive: true });
    const missing = captureBuildIdentity(root);
    assert.equal(missing.artifactHashes["server/dist/campaign-privacy.js"], null);
    const bytes = "privacy fixture bytes";
    writeFileSync(join(root, "server", "dist", "campaign-privacy.js"), bytes);
    const present = captureBuildIdentity(root);
    assert.equal(present.artifactHashes["server/dist/campaign-privacy.js"],
      createHash("sha256").update(bytes).digest("hex"));
    assert.equal(Object.hasOwn(present.artifactHashes, "server/dist/context/campaign-privacy.js"), false);
    assert.notEqual(present.manifestDigest, missing.manifestDigest);
    assert.equal(missing.artifactHashes["server/dist/campaign-privacy.js"], null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
