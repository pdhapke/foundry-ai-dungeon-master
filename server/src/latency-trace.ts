import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
const processRunId = randomUUID();

export const validTraceId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export interface LatencyRow { schemaVersion: 1; traceId: string; component: string; stage: string; elapsedMs: number; durationMs?: number; outcome?: string; clockId?: string; nativeStartMs?: number; nativeEndMs?: number; instrumentationBuild?: string }
const context = new AsyncLocalStorage<{ traceId: string; started: number }>();
export const currentTraceId = () => context.getStore()?.traceId;
export const withLatencyTrace = <T>(traceId: string | undefined, work: () => T): T => validTraceId(traceId) ? context.run({ traceId, started: performance.now() }, work) : work();

/** Bounded asynchronous telemetry. Never delay mechanics or fail an action on
 * telemetry errors; explicit dropped/errors counters prevent false completeness.
 * Two files, each capped near 4MiB. No user text, args, targets or credentials.
 */
export class LatencySink {
  private queue: string[] = [];
  private draining: Promise<void> | undefined;
  dropped = 0;
  errors = 0;
  constructor(readonly path: string, private readonly maxBytes = 4 * 1024 * 1024) {}
  record(row: LatencyRow): void {
    if (!validTraceId(row.traceId) || !/^[a-z0-9:_-]{1,100}$/i.test(row.stage) || !/^[a-z0-9_-]{1,40}$/i.test(row.component) || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 || (row.durationMs !== undefined && (!Number.isFinite(row.durationMs) || row.durationMs < 0))) return;
    if (this.queue.length >= 512) { this.dropped++; return; }
    // Project even typed callers: never serialize arbitrary extra properties.
    this.queue.push(JSON.stringify({ schemaVersion: 1, processRunId, monotonicMs: performance.now(), traceId: row.traceId, component: row.component, stage: row.stage, elapsedMs: row.elapsedMs,
      ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      ...(["returned", "error", "cancelled", "confirmed", "failure", "uncertain"].includes(row.outcome ?? "") ? { outcome: row.outcome } : {}),
      ...(validTraceId(row.clockId) && Number.isFinite(row.nativeStartMs) && Number.isFinite(row.nativeEndMs) && row.nativeEndMs! >= row.nativeStartMs! ? { clockId: row.clockId, nativeStartMs: row.nativeStartMs, nativeEndMs: row.nativeEndMs } : {}),
      ...(typeof row.instrumentationBuild === "string" && /^[a-f0-9]{64}$/.test(row.instrumentationBuild) ? { instrumentationBuild: row.instrumentationBuild } : {}) }) + "\n");
    this.draining ??= this.drain();
  }
  async flush(): Promise<void> { while (this.draining) await this.draining; }
  private async drain(): Promise<void> {
    let inFlight = 0;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      while (this.queue.length) {
        const rows = this.queue.splice(0, 128); inFlight = rows.length;
        const batch = rows.join("");
        const bytes = (await stat(this.path).catch(() => ({ size: 0 }))).size;
        if (bytes + Buffer.byteLength(batch) > this.maxBytes) {
          await unlink(this.path + ".1").catch(() => undefined);
          await rename(this.path, this.path + ".1").catch(() => undefined);
        }
        await appendFile(this.path, batch, "utf8");
        inFlight = 0;
      }
    } catch { this.errors++; this.dropped += this.queue.length + inFlight; this.queue = []; }
    finally { this.draining = undefined; }
  }
}
let sink: LatencySink | undefined;
let component = "ai-node";
export function configureLatencyTrace(path: string, name = "ai-node"): LatencySink { component = name; return sink = new LatencySink(path); }
export function latencyDiagnostics() { return { schemaVersion: 1, processRunId, enabled: Boolean(sink), dropped: sink?.dropped ?? 0, errors: sink?.errors ?? 0, retention: "two files, approximately 4MiB each; bounded queue 512" }; }
export function latencyEvent(stage: string, durationMs?: number, outcome?: string): void {
  const current = context.getStore();
  if (!current || !sink) return;
  sink.record({ schemaVersion: 1, traceId: current.traceId, component, stage, elapsedMs: performance.now() - current.started,
    ...(durationMs === undefined ? {} : { durationMs }), ...(outcome ? { outcome } : {}) });
}
export async function latencySpan<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now(); let outcome = "error";
  try { const result = await work(); outcome = "returned"; return result; }
  finally { latencyEvent(stage, performance.now() - started, outcome); }
}
export function nativeLatencyEvent(stage: string, native: { clockId: string; nativeStartMs: number; nativeEndMs: number; nativeExecutionMs: number; instrumentationBuild?: string }): void {
  const current = context.getStore();
  if (current && sink) sink.record({ schemaVersion: 1, traceId: current.traceId, component: "foundry-native", stage,
    elapsedMs: 0, durationMs: native.nativeExecutionMs, clockId: native.clockId, nativeStartMs: native.nativeStartMs, nativeEndMs: native.nativeEndMs,
    ...(native.instrumentationBuild ? { instrumentationBuild: native.instrumentationBuild } : {}) });
}
