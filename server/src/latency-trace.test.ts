import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatencySink, configureLatencyTrace, latencySpan, withLatencyTrace } from "./latency-trace.js";
const id = "00000000-0000-4000-8000-000000000001";
void test("durable trace projects fields, measures same-clock spans and isolates concurrent contexts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "latency-"));
  try {
    const path = join(dir, "trace.jsonl"), sink = configureLatencyTrace(path);
    await Promise.all([withLatencyTrace(id, () => latencySpan("controlled-work", async () => 3)), withLatencyTrace("00000000-0000-4000-8000-000000000002", () => latencySpan("other-work", async () => 4))]);
    sink.record({ schemaVersion: 1, traceId: id, component: "ai-node", stage: "safe", elapsedMs: 1, secret: "PRIVATE" } as never);
    await sink.flush();
    const text = await readFile(path, "utf8"), rows = text.trim().split("\n").map(l => JSON.parse(l));
    assert.equal(rows.length, 3); assert.ok(!text.includes("PRIVATE"));
    assert.equal(rows.find(r => r.stage === "controlled-work").traceId, id);
    assert.ok(rows.every(r => Number.isFinite(r.monotonicMs) && r.processRunId));
    assert.equal(sink.errors, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
void test("telemetry failure counts lost in-flight batch and never rejects mechanics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "latency-"));
  try {
    const blocked = join(dir, "file"); await writeFile(blocked, "not directory");
    const sink = new LatencySink(join(blocked, "trace.jsonl"));
    sink.record({ schemaVersion: 1, traceId: id, component: "test", stage: "failed-write", elapsedMs: 0 });
    await sink.flush(); assert.equal(sink.errors, 1); assert.equal(sink.dropped, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
