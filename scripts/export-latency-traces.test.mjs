import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
void test("offline export preserves Python scope and request evidence without content", () => {
  const directory = mkdtempSync(join(tmpdir(), "ai-dm-trace-export-"));
  try {
    const traceId = "12345678-1234-1234-1234-123456789abc";
    const file = join(directory,"trace.jsonl");
    const metadata = { schemaVersion:1, traceId, component:"python", scopeId:"scope-fixture", stage:"model-provider-request-id-unavailable", request:1, toolCalls:1, transportRetryLimit:0, providerResponseHash:"a".repeat(24), providerRequestHash:"b".repeat(24), callHash:"c".repeat(24), itemHash:"d".repeat(24), eventType:"response.completed", sinceModelRequestMs:10, elapsedMs:12 };
    writeFileSync(file, JSON.stringify({ ...metadata, prompt:"PRIVATE PROMPT", arguments:{ secret:"PRIVATE ARGUMENTS" }, authorization:"PRIVATE HEADER" }) + "\n");
    const result = spawnSync(process.execPath,[fileURLToPath(new URL("./export-latency-traces.mjs",import.meta.url)),file],{encoding:"utf8",windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    const exported = JSON.parse(result.stdout);
    assert.deepEqual(exported.traces[traceId][0],metadata);
    assert.ok(!result.stdout.includes("PRIVATE"));
    assert.ok(exported.notes.some((note) => note.includes("identical traceId, component and scopeId")));
    assert.ok(exported.notes.some((note) => note.includes("missing scopeId")));
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("ai-dm-trace-export-"));
    rmSync(target,{recursive:true,force:true});
  }
});
