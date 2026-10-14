import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { managedCredentialRemediated } from "./tunnel-remediation.js";

void test("managed runtime proof fails closed for absent marker, mismatched key, unresolved lock and ACL failure", t => {
  const temporary = mkdtempSync(join(tmpdir(), "foundry-remediation-synthetic-")); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const directory = join(temporary, "managed"); mkdirSync(directory);
  const key = "a".repeat(64), hash = createHash("sha256").update(key).digest("hex");
  writeFileSync(join(directory, "current.json"), JSON.stringify({ version: 1, generation: 1, key }));
  assert.equal(managedCredentialRemediated(directory, hash, () => undefined), false);
  writeFileSync(`${directory}.required`, "managed-v1\n");
  assert.equal(managedCredentialRemediated(directory, hash, () => undefined), true);
  assert.equal(managedCredentialRemediated(directory, "b".repeat(64), () => undefined), false);
  assert.equal(managedCredentialRemediated(directory, hash, () => { throw new Error("synthetic ACL"); }), false);
  mkdirSync(join(temporary, ".managed-credential.lock"));
  assert.equal(managedCredentialRemediated(directory, hash, () => undefined), false);
});
