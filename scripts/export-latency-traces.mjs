// Offline readout. Pass explicit local trace files, optionally --trace UUID.
// Never sums overlapping spans or subtracts clocks from different processes.
import { readFileSync } from "node:fs";
const args = process.argv.slice(2), selected = args.indexOf("--trace");
let traceId;
if (selected >= 0) { traceId = args[selected + 1]; args.splice(selected, 2); }
if (!args.length) throw Error("Pass latency-traces.jsonl files (include .1 rotations if needed)");
const safeKeys = ["schemaVersion", "traceId", "component", "stage", "durationMs", "elapsedMs", "scopeId", "processRunId", "monotonicMs", "clockId", "nativeStartMs", "nativeEndMs", "instrumentationBuild", "outcome", "requestCount", "toolCount", "requestId", "providerResponseId", "callId", "request", "toolCalls", "transportRetryLimit", "providerResponseHash", "providerRequestHash", "callHash", "itemHash", "eventType", "sinceModelRequestMs"];
const traces = new Map(); let malformed = 0;
for (const path of args) {
  const bytes = readFileSync(path);
  if (bytes.length > 16 * 1024 * 1024) throw Error("Input exceeds bounded trace-file budget");
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (row.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/i.test(row.traceId ?? "") || typeof row.stage !== "string") { malformed++; continue; }
    if (traceId && row.traceId !== traceId) continue;
    const projected = Object.fromEntries(safeKeys.filter(k => row[k] !== undefined && ["string", "number", "boolean"].includes(typeof row[k])).map(k => [k, row[k]]));
    const rows = traces.get(row.traceId) ?? []; rows.push(projected); traces.set(row.traceId, rows);
  }
}
console.log(JSON.stringify({ schemaVersion: 1, malformed, notes: ["durationMs is measured within its originating clock", "elapsedMs requires identical traceId, component and scopeId where provided; missing scopeId is unavailable scope evidence", "monotonicMs requires matching processRunId", "spans overlap: do not add them", "native versus browser subtraction requires identical clockId", "missing rows are unavailable evidence; inspect health dropped/errors and rotations"], traces: Object.fromEntries(traces) }, null, 2));
