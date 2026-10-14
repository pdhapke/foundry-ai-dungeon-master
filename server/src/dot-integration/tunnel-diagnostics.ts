import { randomUUID } from "node:crypto";
import { lstat, open, opendir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { TUNNEL_HOST_DIAGNOSTIC_SIGNALS, TUNNEL_HOST_FAILURE_CODES } from "./tunnel-host.js";
import { createAsyncWindowsPrivateStorageVerifier, type AsyncPrivateStorageVerifier } from "./windows-security.js";

export const DIAGNOSTIC_LIMITS = { files: 16, bytes: 32768, events: 64 } as const;
const attemptId = z.string().regex(/^attempt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const phase = z.enum(["prepare", "runtime", "bind", "revalidate", "host_start", "host_health", "host_shutdown"]);
const reason = z.enum(["inactive", "remediation_required", "configuration_unsafe", "controller_mismatch", "dot_mode_required", "activation_loaded", "running", "host_failed", "scope_changed", "busy"]);
const duration = z.number().finite().min(0).max(604800000);
const pid = z.number().int().min(1).max(4294967295);
const exitCode = z.number().int().min(-2147483648).max(4294967295).nullable();
// Each input is projected into literals, enums, booleans and bounded numbers.
// Unknown fields (including raw output/error/config objects) never reach disk.
const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("phase_start"), phase }),
  z.object({ kind: z.literal("phase_end"), phase, durationMs: duration }),
  z.object({ kind: z.literal("validation"), phase: z.enum(["prepare", "revalidate"]), ok: z.boolean() }),
  z.object({ kind: z.literal("failure"), code: z.enum(TUNNEL_HOST_FAILURE_CODES) }),
  z.object({ kind: z.literal("lifecycle_failure"), phase, code: reason }),
  z.object({ kind: z.literal("spawned"), hostPid: pid, childPid: pid }),
  z.object({ kind: z.literal("exit"), process: z.enum(["host", "child"]), exitCode, signal: z.enum(TUNNEL_HOST_DIAGNOSTIC_SIGNALS).nullable() }),
  z.object({ kind: z.literal("health"), healthy: z.boolean(), ready: z.boolean() }),
]);
const storedEventSchema = z.discriminatedUnion("kind", eventSchema.options.map(schema => schema.strict()) as typeof eventSchema.options);
const timedEventSchema = z.object({ elapsedMs: duration, event: storedEventSchema }).strict();
const recordSchema = z.object({
  version: z.literal(1), id: attemptId, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  outcome: z.enum(["in_progress", "running", "failed", "stopped"]),
  events: z.array(timedEventSchema).max(DIAGNOSTIC_LIMITS.events), droppedEvents: z.number().int().min(0).max(4294967295),
}).strict();
type DiagnosticRecord = z.infer<typeof recordSchema>;
export interface TunnelDiagnosticDescriptor { diagnosticId: string; diagnosticStorage: "saved" | "unavailable" }
export interface TunnelDiagnosticAttempt {
  descriptor(): TunnelDiagnosticDescriptor;
  record(event: unknown): void;
  finish(outcome: "running" | "failed" | "stopped"): void;
  flush(): Promise<void>;
}
export interface TunnelDiagnostics { begin(): TunnelDiagnosticAttempt; latest(): TunnelDiagnosticDescriptor | undefined; restore(): Promise<void> }
interface Entry { name: string; record: DiagnosticRecord }
const filename = (id: string): string => `diagnostic-${id}.json`;
const temporaryName = (id: string): string => `.diagnostic-${id}.tmp`;
const filePattern = /^(?:diagnostic-(attempt-[a-f0-9-]{36})\.json|\.diagnostic-(attempt-[a-f0-9-]{36})\.tmp)$/;

/** No writes on construction, mkdir, ACL repair or secret reads. Files inherit
 * the existing protected AI-owned root. All diagnostic IO is best-effort and
 * cannot bypass activation checks or interfere with owned-process cleanup. */
export class ProtectedTunnelDiagnostics implements TunnelDiagnostics {
  private current: TunnelDiagnosticDescriptor | undefined;
  private readonly active = new Set<string>();
  private restored: Promise<void> | undefined;
  private work: Promise<void> = Promise.resolve();
  constructor(readonly root: string,
    private readonly assertPrivate: AsyncPrivateStorageVerifier = createAsyncWindowsPrivateStorageVerifier(root),
    private readonly io: { write(fd: FileHandle, bytes: Buffer): Promise<void>; flush(fd: FileHandle): Promise<void>; rename(from: string, to: string): Promise<void> } = { write: async (fd, bytes) => { await fd.writeFile(bytes); }, flush: async fd => { await fd.sync(); }, rename },
    private readonly now: () => number = Date.now,
  ) {}
  private async read(name: string): Promise<DiagnosticRecord> {
    const path = join(this.root, name); await this.assertPrivate([path]);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > DIAGNOSTIC_LIMITS.bytes) throw new Error();
    const fd = await open(path, "r");
    try {
      const current = await fd.stat();
      if (!current.isFile() || current.nlink !== 1 || current.size > DIAGNOSTIC_LIMITS.bytes || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error();
      const bytes = Buffer.alloc(DIAGNOSTIC_LIMITS.bytes + 1);
      const { bytesRead: length } = await fd.read(bytes, 0, bytes.length, 0);
      if (length > DIAGNOSTIC_LIMITS.bytes || length !== current.size) throw new Error();
      const record = recordSchema.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
      if (name !== filename(record.id) && name !== temporaryName(record.id)) throw new Error();
      return record;
    } finally { await fd.close(); }
  }
  private async entries(): Promise<Entry[]> {
    // Attest the root before opening it, even when there are no records yet.
    await this.assertPrivate([join(this.root, filename(`attempt-${randomUUID()}`))]);
    const entries: Entry[] = [], directory = await opendir(this.root);
    let scanned = 0;
    try {
      for (let item = await directory.read(); item; item = await directory.read()) {
        if (++scanned > 512) throw new Error();
        if (!filePattern.test(item.name)) continue;
        if (entries.length >= DIAGNOSTIC_LIMITS.files + 1) throw new Error();
        entries.push({ name: item.name, record: await this.read(item.name) });
      }
    } finally { await directory.close(); }
    return entries.sort((a, b) => a.record.updatedAt.localeCompare(b.record.updatedAt) || a.name.localeCompare(b.name));
  }
  latest(): TunnelDiagnosticDescriptor | undefined {
    return this.current ? { ...this.current } : undefined;
  }
  restore(): Promise<void> {
    this.restored ??= (async () => { try {
      const entry = (await this.entries()).at(-1);
      if (entry && !this.current) this.current = { diagnosticId: entry.record.id, diagnosticStorage: entry.name === filename(entry.record.id) ? "saved" : "unavailable" };
    } catch { /* No filesystem/parser exception text crosses the boundary. */ } })();
    return this.restored;
  }
  begin(): TunnelDiagnosticAttempt {
    const id = `attempt-${randomUUID()}`, started = this.now();
    let stored = false, writable = true, closed = false;
    const record: DiagnosticRecord = { version: 1, id, createdAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(), outcome: "in_progress", events: [], droppedEvents: 0 };
    const descriptor = (): TunnelDiagnosticDescriptor => ({ diagnosticId: id, diagnosticStorage: stored ? "saved" : "unavailable" });
    this.current = descriptor();
    if (this.active.size >= DIAGNOSTIC_LIMITS.files - 1) writable = false; else this.active.add(id);
    const initialize = async (): Promise<void> => { try {
      if (!writable) return;
      const entries = await this.entries();
      while (entries.length >= DIAGNOSTIC_LIMITS.files - 1) {
        const index = entries.findIndex(entry => !this.active.has(entry.record.id));
        if (index < 0) throw new Error();
        const entry = entries.splice(index, 1)[0]!;
        await this.read(entry.name); await unlink(join(this.root, entry.name));
      }
    } catch { writable = false; } };
    const commit = async (snapshot: DiagnosticRecord): Promise<void> => {
      if (!writable) return;
      const target = join(this.root, filename(id)), temporary = join(this.root, temporaryName(id));
      let fd: FileHandle | undefined;
      let createdTemporary = false;
      try {
        // Rotation happens once before this attempt. Reserve a temporary slot;
        // malformed matching files are preserved and disable diagnostic IO.
        await this.assertPrivate([target, temporary]);
        try { await lstat(target); await this.read(filename(id)); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        const bytes = Buffer.from(JSON.stringify(recordSchema.parse(snapshot)) + "\n");
        if (bytes.length > DIAGNOSTIC_LIMITS.bytes) throw new Error();
        fd = await open(temporary, "wx", 0o600);
        createdTemporary = true;
        await this.io.write(fd, bytes); await this.io.flush(fd); await fd.close(); fd = undefined;
        await this.assertPrivate([target, temporary]);
        const stat = await lstat(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length) throw new Error();
        await this.io.rename(temporary, target); createdTemporary = false; stored = true;
      } catch { stored = false; writable = false; }
      finally {
        if (fd !== undefined) { try { await fd.close(); } catch { /* contained */ } }
        // Delete only this exact generated, verified temporary file. A crash
        // leaves its bounded structural record available for the next reader.
        if (createdTemporary) try { await this.assertPrivate([temporary]); const stat = await lstat(temporary); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) await unlink(temporary); } catch { /* preserve on uncertainty */ }
        if (this.current?.diagnosticId === id) this.current = descriptor();
      }
    };
    // One coalescing pending snapshot bounds memory even if observers flood it.
    // Serialized writes and rotation are asynchronous; cleanup never waits here.
    let revision = 1, completed = 0;
    let pending: { revision: number; record: DiagnosticRecord } | undefined = { revision, record: recordSchema.parse(record) };
    const fences: { revision: number; resolve(): void }[] = [];
    let draining: Promise<void> | undefined;
    let initialized = false;
    const drain = (): Promise<void> => {
      if (draining) return draining;
      draining = this.work.then(async () => {
        if (!initialized) { initialized = true; await initialize(); }
        while (pending) {
          const snapshot = pending; pending = undefined; await commit(snapshot.record); completed = snapshot.revision;
          for (let index = fences.length - 1; index >= 0; index--) if (fences[index]!.revision <= completed) fences.splice(index, 1)[0]!.resolve();
        }
      }).catch(() => { stored = false; writable = false; pending = undefined; completed = revision; for (const fence of fences.splice(0)) fence.resolve(); }).finally(() => {
        draining = undefined; if (this.current?.diagnosticId === id) this.current = descriptor();
        if (pending) void drain(); else if (closed) this.active.delete(id);
      });
      this.work = draining;
      return draining;
    };
    const enqueue = (): void => { record.updatedAt = new Date(this.now()).toISOString(); pending = { revision: ++revision, record: recordSchema.parse(record) }; void drain(); };
    void drain();
    return {
      descriptor,
      record: input => {
        if (closed) return;
        try {
          const parsed = eventSchema.safeParse(input); if (!parsed.success) return;
          const event = { elapsedMs: Math.min(604800000, Math.max(0, this.now() - started)), event: parsed.data };
          // Keep recent transitions and the original phase start under a hard cap.
          if (record.events.length === DIAGNOSTIC_LIMITS.events) { record.events.splice(1, 1); record.droppedEvents = Math.min(4294967295, record.droppedEvents + 1); }
          record.events.push(event); enqueue();
        } catch { /* Even malicious observers or clocks cannot break cleanup. */ }
      },
      finish: outcome => { if (closed) return; try { record.outcome = outcome; enqueue(); if (outcome !== "running") closed = true; } catch { /* contained */ } },
      flush: () => {
        if (completed >= revision || fences.length >= DIAGNOSTIC_LIMITS.events) return Promise.resolve();
        // Fence only the snapshot present now. Later health transitions cannot
        // indefinitely retain activation's busy flag or prevent explicit Stop.
        return new Promise<void>(resolve => { fences.push({ revision, resolve }); void drain(); });
      },
    };
  }
}
