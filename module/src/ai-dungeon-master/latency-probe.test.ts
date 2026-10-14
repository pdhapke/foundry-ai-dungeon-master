import assert from "node:assert/strict";
import test from "node:test";
import { BrowserLatencyProbe, latencyRows, latencyDiagnostics } from "./latency-probe.js";
void test("fragmented SSE receipt metadata correlates without retaining text", () => {
  const p = new BrowserLatencyProbe();
  const data = new TextEncoder().encode('data: {"type":"thread.item.done","item":{"id":"msg_receipt_fixture","content":[{"text":"PRIVATE GAME TEXT"}]}}\r\n\r\n');
  for (let i = 0; i < data.length; i++) p.chunk(data.slice(i,i+1));
  const mine = latencyRows().filter((r) => r.traceId === p.traceId);
  assert.deepEqual(mine.map((r) => r.stage), ["browser-submit", "browser-first-stream-chunk", "browser-receipt-arrival"]);
  assert.ok(mine.every((r) => r.elapsedMs >= 0));
  assert.ok(!JSON.stringify(mine).includes("PRIVATE"));
  assert.ok(!mine.some((r) => r.stage.includes("render")));
});
void test("stream diagnostic budgets and malformed content never throw", () => {
  const p = new BrowserLatencyProbe();
  p.chunk(new TextEncoder().encode("x".repeat(70000)));
  p.chunk(new TextEncoder().encode("data: malformed\n\n"));
  assert.ok(latencyRows().some((r) => r.traceId === p.traceId && r.stage === "browser-diagnostic-event-over-budget"));
  for (let i=0;i<1200;i++) p.mark("browser-response-headers");
  assert.ok(latencyRows().length <= 1000);
  assert.ok(latencyDiagnostics().droppedRows > 0);
  assert.ok(latencyDiagnostics().overBudgetEvents > 0);
});

void test("direct JSON action receipt gets a browser arrival boundary", () => {
  const p = new BrowserLatencyProbe();
  p.chunk(new TextEncoder().encode('{"ok":true,"result":{"outcome":"confirmed","secretGameText":"private"}}'));
  p.finish();
  const mine = latencyRows().filter((r) => r.traceId === p.traceId);
  assert.ok(mine.some((r) => r.stage === "browser-action-receipt-arrival"));
  assert.ok(!JSON.stringify(mine).includes("secretGameText"));
});
