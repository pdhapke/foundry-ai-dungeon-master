/** Passive transport diagnostics: metadata only; receipt arrival is not rendered visibility. */
export interface BrowserLatencyRow {
  schemaVersion: 1;
  traceId: string;
  component: "browser";
  stage: string;
  elapsedMs: number;
  clockId: string;
  timeOrigin: number;
  atMs: number;
}
const rows: BrowserLatencyRow[] = [];
const diagnostics = { droppedRows: 0, overBudgetEvents: 0 };
export function latencyDiagnostics(): typeof diagnostics { return { ...diagnostics }; }
export function latencyRows(): BrowserLatencyRow[] { return rows.map((row) => ({ ...row })); }
export class BrowserLatencyProbe {
  readonly started = performance.now();
  readonly clockId = (() => {
    const scope = globalThis as typeof globalThis & { __foundryLatencyClockId?: string };
    return scope.__foundryLatencyClockId ??= crypto.randomUUID();
  })();
  readonly traceId = crypto.randomUUID();
  #decoder = new TextDecoder();
  #buffer = "";
  #first = true;
  constructor() { this.mark("browser-submit"); }
  mark(stage: string): void {
    rows.push({ schemaVersion: 1, traceId: this.traceId, component: "browser", stage, elapsedMs: performance.now() - this.started, clockId: this.clockId, timeOrigin: performance.timeOrigin, atMs: performance.now() });
    if (rows.length > 1000) {
      diagnostics.droppedRows += rows.length - 1000;
      rows.splice(0, rows.length - 1000);
    }
  }
  finish(): void {
    try {
      const value = JSON.parse(this.#buffer) as { result?: { outcome?: unknown } };
      if (typeof value.result?.outcome === "string") this.mark("browser-action-receipt-arrival");
    } catch { /* SSE completion or nonreceipt JSON. */ }
    this.#buffer = "";
  }

  chunk(bytes: Uint8Array): void {
    if (this.#first) { this.mark("browser-first-stream-chunk"); this.#first = false; }
    this.#buffer = (this.#buffer + this.#decoder.decode(bytes, { stream: true })).replace(/\r\n/g, "\n");
    // Diagnostic cap never truncates or changes the actual response stream.
    if (this.#buffer.length > 65536) { this.#buffer = ""; diagnostics.overBudgetEvents++; this.mark("browser-diagnostic-event-over-budget"); return; }
    let index: number;
    while ((index = this.#buffer.indexOf("\n\n")) >= 0) {
      const frame = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      try {
        const event = JSON.parse(data) as { type?: unknown; item?: { id?: unknown } };
        if (event.type === "thread.item.done" && typeof event.item?.id === "string" && event.item.id.startsWith("msg_receipt_")) this.mark("browser-receipt-arrival");
      } catch { /* Heartbeat/non-JSON frames carry no receipt evidence. */ }
    }
  }
}
export function latencyDownloadButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "ai-dm-latency-export";
  button.type = "button"; button.textContent = "Export latency diagnostics";
  button.title = "Metadata timings only. Receipt arrival does not prove chat rendering.";
  button.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, renderedReceipt: "unobserved: requires browser observation", diagnostics: latencyDiagnostics(), events: latencyRows() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = "ai-dm-browser-latency.json"; link.click(); URL.revokeObjectURL(url);
  });
  return button;
}
