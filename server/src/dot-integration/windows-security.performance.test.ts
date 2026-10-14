import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWindowsPrivateStorageVerifier, runPrivatePowerShell } from "./windows-security.js";

/** Explicit source-only benchmark. Reads ACL metadata solely on new TEMP
 * fixtures; never invokes a host, reads setup files, or changes permissions. */
void test("synthetic PowerShell startup and ACL component timing", { skip: process.platform !== "win32" || process.env["FOUNDRY_DOT_SYNTHETIC_ACL_BENCHMARK"] !== "1" }, t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-dot-acl-benchmark-"));
  t.after(() => {
    const checked = resolve(root), prefix = join(resolve(tmpdir()), "foundry-dot-acl-benchmark-");
    if (!checked.startsWith(prefix)) throw new Error("Unsafe synthetic cleanup.");
    rmSync(checked, { recursive: true, force: true });
  });
  const target = join(root, "fixture.txt"); writeFileSync(target, "synthetic metadata fixture");
  const samples: { component: string; elapsedMs: number; paths?: number; result: string }[] = [];
  for (let index = 0; index < 2; index++) {
    const start = performance.now();
    assert.equal(runPrivatePowerShell("[Console]::Out.Write('synthetic-readonly-startup-v1')", ""), "synthetic-readonly-startup-v1");
    samples.push({ component: "powershell_startup", elapsedMs: performance.now() - start, result: "confirmed" });
  }
  const verifier = createWindowsPrivateStorageVerifier(root);
  for (const paths of [[target], [target, join(root, "absent.txt")]]) {
    const start = performance.now(); let result = "verified";
    try { if (paths.length === 1) verifier(paths[0]!); else verifier.verifyMany!(paths); }
    catch { result = "refused"; } // Default TEMP ACL can be broad; no automatic repair.
    samples.push({ component: "synthetic_acl_metadata", elapsedMs: performance.now() - start, paths: paths.length, result });
  }
  assert.ok(samples.every(sample => Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0));
  t.diagnostic(JSON.stringify({ samples }));
});
