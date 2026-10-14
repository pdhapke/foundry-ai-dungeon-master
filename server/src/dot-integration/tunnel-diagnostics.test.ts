import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DIAGNOSTIC_LIMITS, ProtectedTunnelDiagnostics } from "./tunnel-diagnostics.js";
import type { AsyncPrivateStorageVerifier } from "./windows-security.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "foundry-diagnostic-test-"));
  const checks: string[] = [];
  let unsafe = false, time = Date.UTC(2026, 9, 10);
  const verify: AsyncPrivateStorageVerifier = paths => { checks.push(...paths); return unsafe ? Promise.reject(new Error("sk-secret-private-error")) : Promise.resolve(); };
  const journal = new ProtectedTunnelDiagnostics(root, verify, undefined, () => time++);
  return { root, journal, verify, checks, unsafe: () => { unsafe = true; }, dispose: () => { rmSync(root, { recursive: true, force: true }); } };
}
const files = (root: string): string[] => readdirSync(root).filter(name => name.startsWith("diagnostic-") || name.startsWith(".diagnostic-"));
const json = (root: string, id: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, `diagnostic-${id}.json`), "utf8")) as Record<string, unknown>;

void test("disabled construction does no IO; generated attempt durably records fixed structural fields only", async () => {
  const f = fixture();
  try {
    assert.equal(f.checks.length, 0); assert.deepEqual(files(f.root), []);
    const attempt = f.journal.begin(), id = attempt.descriptor().diagnosticId; await attempt.flush();
    assert.match(id, /^attempt-[a-f0-9-]{36}$/); assert.equal(attempt.descriptor().diagnosticStorage, "saved");
    attempt.record({ kind: "spawned", hostPid: 101, childPid: 102, argv: "sk-secret" });
    attempt.record({ kind: "exit", process: "child", exitCode: 17, signal: null, stderr: "sk-secret" });
    attempt.record({ kind: "validation", phase: "prepare", ok: true, config: { token: "sk-secret" } });
    attempt.record({ kind: "failure", code: "child_exited", message: "sk-secret" });
    attempt.record({ kind: "phase_end", phase: "host_health", durationMs: 123 });
    attempt.finish("failed"); await attempt.flush();
    const record = json(f.root, id), text = JSON.stringify(record);
    assert.equal(record["outcome"], "failed"); assert.equal((record["events"] as unknown[]).length, 5);
    assert.ok(!text.includes("sk-secret") && !text.includes("argv") && !text.includes("stderr") && !text.includes("config"));
    assert.ok(f.checks.every(path => path.startsWith(f.root)));
  } finally { f.dispose(); }
});
void test("injected error/parser/unknown enum values are not written; no raw error message escapes", async () => {
  const f = fixture();
  try {
    const attempt = f.journal.begin();
    for (const input of [new Error("sk-secret"), { kind: "failure", code: "sk-secret" }, { kind: "health", healthy: "sk-secret", ready: true }, { kind: "exit", process: "child", exitCode: Infinity, signal: "sk-secret" }, { kind: "spawned", hostPid: -1, childPid: 3 }, { kind: "phase_end", phase: "sk-secret", durationMs: 1 }]) attempt.record(input);
    attempt.finish("failed"); await attempt.flush(); assert.deepEqual(json(f.root, attempt.descriptor().diagnosticId)["events"], []);
    assert.ok(!JSON.stringify(attempt.descriptor()).includes("sk-secret"));
  } finally { f.dispose(); }
});
void test("hard event and byte bounds retain original and latest events and a dropped count", async () => {
  const f = fixture();
  try {
    const attempt = f.journal.begin();
    attempt.record({ kind: "phase_start", phase: "prepare" });
    for (let index = 0; index < 100; index++) attempt.record({ kind: "health", healthy: true, ready: index === 99 });
    attempt.finish("failed"); await attempt.flush();
    const record = json(f.root, attempt.descriptor().diagnosticId), events = record["events"] as { event: { kind: string; ready?: boolean } }[];
    assert.equal(events.length, DIAGNOSTIC_LIMITS.events); assert.equal(record["droppedEvents"], 37);
    assert.equal(events[0]!.event.kind, "phase_start"); assert.equal(events.at(-1)!.event.ready, true);
    assert.ok(Buffer.byteLength(JSON.stringify(record)) < DIAGNOSTIC_LIMITS.bytes);
  } finally { f.dispose(); }
});
void test("rotation remains bounded across attempts and preserves active attempt and unrelated user file", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "operator-notes.txt"), "sk-secret-untouched");
    const active = f.journal.begin(); active.finish("running"); await active.flush();
    for (let index = 0; index < 40; index++) { const attempt = f.journal.begin(); attempt.finish("failed"); await attempt.flush(); assert.ok(files(f.root).length <= DIAGNOSTIC_LIMITS.files); }
    assert.equal(json(f.root, active.descriptor().diagnosticId)["outcome"], "running");
    assert.equal(readFileSync(join(f.root, "operator-notes.txt"), "utf8"), "sk-secret-untouched");
    active.finish("stopped"); await active.flush();
  } finally { f.dispose(); }
});
void test("crashed in-progress records survive restart; latest descriptor is recovered without creating an attempt", async () => {
  const f = fixture();
  try {
    const attempt = f.journal.begin(); attempt.record({ kind: "phase_start", phase: "host_start" }); await attempt.flush();
    const before = files(f.root); const restarted = new ProtectedTunnelDiagnostics(f.root, f.verify);
    await restarted.restore(); assert.deepEqual(restarted.latest(), attempt.descriptor()); assert.deepEqual(files(f.root), before);
    assert.equal(json(f.root, attempt.descriptor().diagnosticId)["outcome"], "in_progress");
    const next = restarted.begin(); next.finish("failed"); await next.flush(); assert.ok(files(f.root).includes(before[0]!));
  } finally { f.dispose(); }
});
void test("crash-only valid temporary record is preserved and never claims the absent final report was saved", async () => {
  const f = fixture();
  try {
    const id = "attempt-11111111-1111-1111-1111-111111111111", name = `.diagnostic-${id}.tmp`;
    writeFileSync(join(f.root, name), JSON.stringify({ version: 1, id, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", outcome: "in_progress", events: [], droppedEvents: 0 }));
    await f.journal.restore(); assert.deepEqual(f.journal.latest(), { diagnosticId: id, diagnosticStorage: "unavailable" });
    assert.deepEqual(files(f.root), [name]);
  } finally { f.dispose(); }
});
void test("concurrent attempts preserve the total file cap and fail closed when active capacity is exhausted", async () => {
  const f = fixture();
  try {
    const attempts = Array.from({ length: 40 }, () => f.journal.begin());
    await Promise.all(attempts.map(attempt => attempt.flush()));
    assert.ok(files(f.root).length <= DIAGNOSTIC_LIMITS.files); assert.ok(attempts.some(attempt => attempt.descriptor().diagnosticStorage === "unavailable"));
    for (const attempt of attempts) attempt.finish("failed");
    await Promise.all(attempts.map(attempt => attempt.flush()));
    assert.ok(files(f.root).length <= DIAGNOSTIC_LIMITS.files);
  } finally { f.dispose(); }
});
void test("durability fence finishes its snapshot even while later health writes remain pending", { timeout: 5000 }, async () => {
  const f = fixture(); let writes = 0, releaseFirst!: () => void, releaseLater!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; }), later = new Promise<void>(resolve => { releaseLater = resolve; });
  const io = {
    write: async (fd: FileHandle, bytes: Buffer): Promise<void> => { writes++; if (writes === 1) await first; else if (writes === 2) await later; await fd.writeFile(bytes); },
    flush: async (fd: FileHandle): Promise<void> => { await fd.sync(); }, rename,
  };
  const journal = new ProtectedTunnelDiagnostics(f.root, f.verify, io), attempt = journal.begin();
  try {
    while (writes === 0) await new Promise<void>(resolve => { setImmediate(resolve); });
    const fence = attempt.flush(); attempt.record({ kind: "health", healthy: true, ready: false });
    releaseFirst(); await fence;
    assert.equal(attempt.descriptor().diagnosticStorage, "saved");
    while (writes < 2) await new Promise<void>(resolve => { setImmediate(resolve); });
    for (let index = 0; index < 100; index++) attempt.record({ kind: "health", healthy: true, ready: false });
    assert.equal(writes, 2); // Later observations are coalesced while IO waits.
  } finally { releaseFirst(); releaseLater(); attempt.finish("failed"); await attempt.flush(); f.dispose(); }
});
void test("stale observers cannot rewrite sealed attempts or replace a newer diagnostic ID", async () => {
  const f = fixture();
  try {
    const old = f.journal.begin(); old.finish("failed"); await old.flush(); const content = json(f.root, old.descriptor().diagnosticId);
    const next = f.journal.begin(); old.record({ kind: "failure", code: "child_exited" }); old.finish("stopped");
    await old.flush(); assert.deepEqual(json(f.root, old.descriptor().diagnosticId), content); assert.deepEqual(f.journal.latest(), next.descriptor()); next.finish("failed"); await next.flush();
  } finally { f.dispose(); }
});
void test("write, flush and rename failures expose only unavailable and preserve previous committed crash evidence", async () => {
  for (const operation of ["write", "flush", "rename"] as const) {
    const f = fixture(); let fail = false;
    try {
      const io = {
        write: async (fd: FileHandle, bytes: Buffer): Promise<void> => { if (fail && operation === "write") throw new Error("sk-secret-stdio"); await fd.writeFile(bytes); },
        flush: async (fd: FileHandle): Promise<void> => { if (fail && operation === "flush") throw new Error("sk-secret-key"); await fd.sync(); },
        rename: async (from: string, to: string): Promise<void> => { if (fail && operation === "rename") throw new Error("sk-secret-env"); await rename(from, to); },
      };
      const journal = new ProtectedTunnelDiagnostics(f.root, f.verify, io), attempt = journal.begin(); await attempt.flush();
      const before = json(f.root, attempt.descriptor().diagnosticId); fail = true;
      assert.doesNotThrow(() => { attempt.record({ kind: "failure", code: "child_exited" }); attempt.finish("failed"); });
      await attempt.flush();
      assert.equal(attempt.descriptor().diagnosticStorage, "unavailable"); assert.deepEqual(json(f.root, attempt.descriptor().diagnosticId), before);
      assert.ok(!JSON.stringify(attempt.descriptor()).includes("sk-secret")); assert.equal(files(f.root).length, 1);
    } finally { f.dispose(); }
  }
});
void test("unsafe private root and malformed or oversized owned-name files fail closed without writes or deletion", async () => {
  for (const kind of ["private", "malformed", "oversized", "extra-field"] as const) {
    const f = fixture();
    try {
      const id = "attempt-11111111-1111-1111-1111-111111111111", path = join(f.root, `diagnostic-${id}.json`);
      if (kind === "private") f.unsafe();
      else if (kind === "extra-field") writeFileSync(path, JSON.stringify({ version: 1, id, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", outcome: "failed", events: [], droppedEvents: 0, secret: "sk-secret" }));
      else writeFileSync(path, kind === "oversized" ? "s".repeat(DIAGNOSTIC_LIMITS.bytes + 1) : "sk-secret-invalid-json");
      const before = files(f.root); await f.journal.restore(); assert.equal(f.journal.latest(), undefined);
      const attempt = f.journal.begin(); attempt.record({ kind: "health", healthy: true, ready: false }); attempt.finish("failed");
      await attempt.flush();
      assert.equal(attempt.descriptor().diagnosticStorage, "unavailable"); assert.deepEqual(files(f.root), before);
    } finally { f.dispose(); }
  }
});
