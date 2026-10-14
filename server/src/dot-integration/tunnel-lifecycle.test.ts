/* Synthetic async mock adapters intentionally resolve synchronously. */
/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import test from "node:test";
import { TunnelLifecycle, TunnelActivationFailure, type TunnelActivationPreparation } from "./tunnel-lifecycle.js";
import type { DotIntegration, DotIntegrationSetup } from "./runtime.js";
import { TunnelHostFailure, type TunnelHost } from "./tunnel-host.js";
import { TunnelConfigurationService } from "./tunnel-configuration.js";
import { randomUUID } from "node:crypto";
import type { TunnelDiagnostics, TunnelDiagnosticAttempt } from "./tunnel-diagnostics.js";

const controller = { worldId: "mcp-test", sceneId: "scene", userId: "gm", clientId: "browser" };
function fixture(diagnostics?: TunnelDiagnostics) {
  const calls: string[] = []; let published: DotIntegration | undefined;
  let refusal: string | undefined, authorized = true, bind = true, dead = false, stopFailed = false;
  let prepareWait: Promise<void> | undefined;
  let throwStage: string | undefined, prepareCalls = 0;
  const callbacks: (() => void)[] = [];
  const runtimes: DotIntegration[] = [];
  const setup = { enabled: true, controller, active: () => true, authenticate: async () => "principal" } as unknown as DotIntegrationSetup;
  const host = (): TunnelHost => {
    const index = callbacks.length;
    return { onExit: callback => { callbacks.push(callback); }, start: async () => { calls.push(`start:${index}`); if (throwStage === "host_start") throw new TunnelHostFailure("process_create_failed"); },
      status: async () => { calls.push(`health:${index}`); if (throwStage === "host_health") throw new TunnelHostFailure("host_status_timeout"); if (dead) throw new Error("synthetic death"); return { healthy: true, ready: false }; },
      stop: async () => { calls.push(`stop:${index}`); if (stopFailed) throw new Error("synthetic uncertain stop"); } };
  };
  const lifecycle = new TunnelLifecycle({
    ...(diagnostics ? { diagnostics } : {}),
    prepare: async current => { calls.push("prepare"); prepareCalls++; if (throwStage === "prepare" || (throwStage === "revalidate" && prepareCalls > 1)) throw new Error("synthetic-secret-raw-error"); if (prepareWait) await prepareWait;
      if (refusal) throw new TunnelActivationFailure(refusal as "remediation_required");
      return { controller: current, executable: "synthetic.exe", profile: "synthetic.yaml", setup } satisfies TunnelActivationPreparation; },
    host, create: current => {
      if (throwStage === "runtime") throw new Error("synthetic-secret-raw-error");
      const runtime = { setup: current, bind: async () => { calls.push("bind"); if (throwStage === "bind") throw new Error("synthetic-secret-raw-error"); return bind; },
        start: () => { calls.push("worker"); }, stop: async () => { calls.push("pause"); } } as unknown as DotIntegration;
      runtimes.push(runtime); return runtime;
    }, publish: runtime => { published = runtime; calls.push(runtime ? "publish" : "revoke"); },
  });
  return { lifecycle, calls, callbacks, runtimes, published: () => published,
    authorized: () => authorized, revoke: () => { authorized = false; },
    fail: (value: string | undefined) => { refusal = value; }, setBind: (value: boolean) => { bind = value; },
    die: () => { dead = true; }, stopFailed: () => { stopFailed = true; }, wait: (value: Promise<void> | undefined) => { prepareWait = value; }, throwAt: (value: string | undefined) => { throwStage = value; } };
}
void test("activation exposes fixed failure phases and host codes, retains the last failed result on display, and never raw errors", async () => {
  for (const phase of ["prepare", "runtime", "bind", "revalidate", "host_start", "host_health"]) {
    const f = fixture(); f.throwAt(phase);
    const failed = await f.lifecycle.activate(controller, f.authorized);
    assert.equal(failed.phase, "failed"); assert.equal(failed.failurePhase, phase); assert.ok(!failed.message.includes("synthetic-secret"));
    assert.equal(failed.hostFailureCode, phase === "host_start" ? "process_create_failed" : phase === "host_health" ? "host_status_timeout" : undefined);
    f.throwAt(undefined); const refreshed = await f.lifecycle.status(controller);
    assert.equal(refreshed.phase, "failed"); assert.equal(refreshed.failurePhase, phase); assert.equal(refreshed.canActivate, true);
    assert.equal((await f.lifecycle.stop(controller)).failurePhase, undefined);
  }
});

function diagnosticFixture() {
  const records: unknown[] = [], attempts: TunnelDiagnosticAttempt[] = [];
  let pending: Promise<void> | undefined, waitPhase: string | undefined, targetPhase = "host_start";
  const diagnostics: TunnelDiagnostics = {
    restore: () => Promise.resolve(), latest: () => attempts.at(-1)?.descriptor(),
    begin: () => {
      const id = `attempt-${randomUUID()}`;
      const attempt: TunnelDiagnosticAttempt = {
        descriptor: () => ({ diagnosticId: id, diagnosticStorage: "saved" }),
        record: event => { records.push(event); if (event && typeof event === "object" && "kind" in event && event.kind === "phase_start" && "phase" in event) waitPhase = String(event.phase); },
        finish: outcome => { records.push({ outcome }); }, flush: () => waitPhase === targetPhase ? pending ?? Promise.resolve() : Promise.resolve(),
      }; attempts.push(attempt); return attempt;
    },
  };
  return { diagnostics, records, attempts, wait: (value: Promise<void> | undefined, phase = "host_start") => { pending = value; targetPhase = phase; }, phase: () => waitPhase };
}
void test("diagnostic IO and observer exceptions do not prevent revocation or exact owned cleanup", async () => {
  const fail = (): never => { throw new Error("sk-secret-diagnostic-io"); };
  const diagnostics: TunnelDiagnostics = { begin: () => ({ descriptor: fail, record: fail, finish: fail, flush: () => Promise.reject(new Error("sk-secret-diagnostic-io")) }), latest: fail, restore: () => Promise.reject(new Error("sk-secret-diagnostic-io")) };
  const f = fixture(diagnostics); f.throwAt("host_start");
  const status = await f.lifecycle.activate(controller, f.authorized);
  assert.equal(status.phase, "failed"); assert.ok(f.calls.includes("revoke") && f.calls.includes("pause") && f.calls.includes("stop:0"));
  assert.equal(f.published(), undefined); assert.ok(!JSON.stringify(status).includes("sk-secret"));
});
void test("shutdown and disconnect during pending diagnostic pre-start flush cannot launch an obsolete host", async () => {
  for (const kind of ["shutdown", "disconnect"] as const) {
    const d = diagnosticFixture(), f = fixture(d.diagnostics); let release!: () => void;
    d.wait(new Promise<void>(resolve => { release = resolve; }));
    const activation = f.lifecycle.activate(controller, f.authorized);
    while (d.phase() !== "host_start") await new Promise<void>(resolve => { setImmediate(resolve); });
    if (kind === "shutdown") await f.lifecycle.shutdown(); else { f.lifecycle.disconnected(controller.clientId); await new Promise<void>(resolve => { setImmediate(resolve); }); }
    assert.equal(f.published(), undefined); assert.ok(f.calls.includes("stop:0"));
    release(); await activation; assert.ok(!f.calls.includes("start:0"));
  }
});
void test("stop cleanup begins before pending diagnostic write completes", async () => {
  const d = diagnosticFixture(), f = fixture(d.diagnostics);
  await f.lifecycle.activate(controller, f.authorized); let release!: () => void;
  d.wait(new Promise<void>(resolve => { release = resolve; }), "host_shutdown");
  const stopping = f.lifecycle.stop(controller);
  await new Promise<void>(resolve => { setImmediate(resolve); });
  assert.equal(f.published(), undefined); assert.ok(f.calls.includes("pause") && f.calls.includes("stop:0"));
  release(); await stopping;
  assert.ok(JSON.stringify(d.records).includes("host_shutdown"));
});
void test("shutdown during pending diagnostic success flush discards stale health", async () => {
  const d = diagnosticFixture(), f = fixture(d.diagnostics); let release!: () => void;
  d.wait(new Promise<void>(resolve => { release = resolve; }), "host_health");
  const activation = f.lifecycle.activate(controller, f.authorized);
  while (d.phase() !== "host_health") await new Promise<void>(resolve => { setImmediate(resolve); });
  await f.lifecycle.shutdown(); release();
  const status = await activation; assert.equal(status.healthy, null); assert.equal(status.ready, null); assert.equal(f.published(), undefined);
});

void test("disabled constructor and failed remediation/status never start or publish", async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); f.fail("remediation_required");
  const status = await f.lifecycle.status(controller);
  assert.equal(status.reason, "remediation_required"); assert.equal(status.canActivate, false); assert.equal(status.healthy, null);
  const result = await f.lifecycle.activate(controller, f.authorized);
  assert.equal(result.canActivate, false); assert.ok(!f.calls.some(call => call.startsWith("start"))); assert.equal(f.published(), undefined);
});
void test("explicit activation binds exact scope before launch; returned Stop works; shutdown pauses and revokes", async () => {
  const f = fixture(); const allowed = await f.lifecycle.status(controller); assert.equal(allowed.canActivate, true);
  const result = await f.lifecycle.activate(controller, f.authorized);
  assert.equal(result.phase, "running"); assert.equal(result.canStop, true); assert.equal(result.healthy, true); assert.equal(result.ready, false);
  assert.ok(f.calls.indexOf("bind") < f.calls.indexOf("start:0")); assert.equal(f.published(), f.runtimes[0]);
  await assert.rejects(f.lifecycle.activate(controller, f.authorized), /pending/);
  await assert.rejects(f.lifecycle.stop({ ...controller, clientId: "other" }), /differs/);
  const stopped = await f.lifecycle.stop(controller); assert.equal(stopped.phase, "inactive"); assert.equal(f.published(), undefined);
  assert.ok(f.calls.includes("pause") && f.calls.includes("stop:0"));
});
void test("revoked caller and failed native binding cannot launch", async () => {
  const f = fixture(); f.revoke(); await f.lifecycle.activate(controller, f.authorized);
  assert.ok(!f.calls.includes("bind") && !f.calls.includes("start:0"));
  const other = fixture(); other.setBind(false); await other.lifecycle.activate(controller, other.authorized);
  assert.ok(!other.calls.includes("start:0")); assert.equal(other.published(), undefined);
});
void test("official child death while wrapper alive revokes on status and stops exact host", async () => {
  const f = fixture(); await f.lifecycle.activate(controller, f.authorized); f.die();
  const result = await f.lifecycle.status(controller); assert.equal(result.phase, "failed"); assert.equal(f.published(), undefined);
  assert.ok(f.calls.includes("pause") && f.calls.includes("stop:0"));
});
void test("stale status/exit callbacks cannot revoke a replacement activation", async () => {
  const f = fixture(); await f.lifecycle.activate(controller, f.authorized);
  let release!: () => void; f.wait(new Promise<void>(resolve => { release = resolve; }));
  const staleStatus = f.lifecycle.status(controller);
  await f.lifecycle.stop(controller); f.wait(undefined);
  await f.lifecycle.activate(controller, f.authorized); const replacement = f.published();
  release(); await staleStatus; f.callbacks[0]!(); await Promise.resolve();
  assert.equal(f.published(), replacement); assert.ok(!f.calls.includes("stop:1")); await f.lifecycle.shutdown();
});
void test("uncertain owned shutdown prevents a second startup", async () => {
  const f = fixture(); await f.lifecycle.activate(controller, f.authorized); f.stopFailed();
  const result = await f.lifecycle.stop(controller); assert.equal(result.phase, "failed"); assert.equal(result.canStop, true);
  assert.equal(f.published(), undefined); await assert.rejects(f.lifecycle.activate(controller, f.authorized));
});
void test("disconnect immediately revokes endpoint and cancels owned runtime", async () => {
  const f = fixture(); await f.lifecycle.activate(controller, f.authorized);
  f.lifecycle.disconnected("unrelated"); assert.ok(f.published());
  f.lifecycle.disconnected(controller.clientId); assert.equal(f.published(), undefined);
  await f.lifecycle.shutdown(); assert.ok(f.calls.includes("pause"));
});
void test("shutdown during pending preparation cannot launch afterward or allow another activation", async () => {
  const f = fixture(); let release!: () => void;
  f.wait(new Promise<void>(resolve => { release = resolve; }));
  const activation = f.lifecycle.activate(controller, f.authorized);
  await f.lifecycle.shutdown(); release(); await activation;
  assert.ok(!f.calls.includes("bind") && !f.calls.includes("start:0")); assert.equal(f.published(), undefined);
  await assert.rejects(f.lifecycle.activate(controller, f.authorized));
  assert.equal((await f.lifecycle.status(controller)).canActivate, false);
});
void test("private configuration channel requires exact displayed scope, explicit confirmation, no credential fields", async () => {
  const f = fixture(), replies: Record<string, unknown>[] = [];
  const service = new TunnelConfigurationService({ status: current => ({ controller: current, configured: true, runtimeKeyConfigured: true, bridgeKeyConfigured: true, activation: "inactive", message: "synthetic" }), save: () => { throw new Error("unexpected save"); } },
    { getVerifiedFoundryIdentity: () => ({ worldId: controller.worldId, userId: controller.userId, userName: "GM", role: 4, isGM: true }), send: raw => { replies.push(JSON.parse(raw) as Record<string, unknown>); return true; } }, async () => controller, "mcp-test", () => !!f.published(), f.lifecycle);
  const request = async (extra: Record<string, unknown>) => { await service.handle({ kind: "dot-tunnel-configuration", requestId: randomUUID(), worldId: controller.worldId, action: "activate", expectedController: controller, ...extra }, { clientId: controller.clientId, userId: controller.userId, lane: "gm" }, () => true); return replies.at(-1)!; };
  assert.equal((await request({}))["errorCode"], "invalid_input");
  assert.equal((await request({ confirmed: true, runtimeKey: "synthetic-unused-key-1234" }))["errorCode"], "invalid_input");
  assert.equal((await request({ confirmed: true, expectedController: { ...controller, sceneId: "other" } }))["errorCode"], "scope_changed");
  await request({ confirmed: true }); assert.ok(f.published());
  const status = await request({ action: "status", expectedController: undefined }); assert.ok(status["status"]);
  await request({ action: "stop", confirmed: true }); assert.equal(f.published(), undefined);
});
