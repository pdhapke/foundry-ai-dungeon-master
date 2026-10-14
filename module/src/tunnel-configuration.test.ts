import assert from "node:assert/strict";
import test from "node:test";
import { CONFIGURATION_TIMEOUT_MS, TUNNEL_HOST_DIAGNOSTIC_CODES, configurationFields, takeConfigurationInput, TunnelConfigurationClient, type TunnelConfigurationStatus } from "./tunnel-configuration.js";
const status: TunnelConfigurationStatus = { configured: false, runtimeKeyConfigured: true, bridgeKeyConfigured: false, tunnelId: `tunnel_${"a".repeat(32)}`, controller: { worldId: "mcp-test", sceneId: "scene", clientId: "client", userId: "gm" }, activation: "inactive", message: "<unsafe>" };
const diagnosticId = "attempt-01234567-89ab-4def-8123-0123456789ab";
void test("diagnostic receipts require a paired fixed storage state and bounded lowercase attempt UUID", async () => {
  let requestId = "";
  const client = new TunnelConfigurationClient("client", () => true, () => "mcp-test", raw => { requestId = (raw as { requestId: string }).requestId; });
  const lifecycle = { phase: "failed", canActivate: true, canStop: false, healthy: null, ready: null, reason: "host_failed", message: "Fixed host failure.", failurePhase: "host_start", hostFailureCode: "process_create_failed" };
  for (const diagnosticStorage of ["saved", "unavailable"] as const) {
    const work = client.request({ action: "status" });
    client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId, status: { ...status, lifecycle: { ...lifecycle, diagnosticId, diagnosticStorage } } });
    const result = await work; assert.equal(result.lifecycle?.diagnosticId, diagnosticId); assert.equal(result.lifecycle?.diagnosticStorage, diagnosticStorage);
  }
  for (const fields of [{ diagnosticId }, { diagnosticStorage: "saved" }, { diagnosticId: "attempt-../synthetic-secret", diagnosticStorage: "saved" },
    { diagnosticId: diagnosticId.toUpperCase(), diagnosticStorage: "saved" }, { diagnosticId: null, diagnosticStorage: "saved" },
    { diagnosticId, diagnosticStorage: "synthetic-secret" }, { diagnosticId, diagnosticStorage: null },
    { diagnosticId, diagnosticStorage: "saved", diagnosticPath: "synthetic-secret" },
    { diagnosticId, diagnosticStorage: "saved", diagnosticCode: "synthetic-secret" },
    { diagnosticId, diagnosticStorage: "saved", diagnostic: { runtimeKey: "synthetic-secret" } }]) {
    const work = client.request({ action: "status" });
    assert.equal(client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId, status: { ...status, lifecycle: { ...lifecycle, ...fields } } }), true);
    await assert.rejects(work, error => error instanceof Error && /could not be verified/.test(error.message) && !error.message.includes("synthetic-secret"));
  }
  const extraStatusField = client.request({ action: "status" });
  client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId, status: { ...status, diagnosticPath: "synthetic-secret" } });
  await assert.rejects(extraStatusField, error => error instanceof Error && !error.message.includes("synthetic-secret"));
});
void test("fixed phase and host diagnostics agree with server whitelist; unknown fields and raw diagnostic text remain rejected", async () => {
  const server = await import(new URL("../../server/src/dot-integration/tunnel-host.ts", import.meta.url).href) as unknown as { TUNNEL_HOST_FAILURE_CODES: readonly string[] };
  assert.deepEqual(TUNNEL_HOST_DIAGNOSTIC_CODES, server.TUNNEL_HOST_FAILURE_CODES);
  let id = ""; const client = new TunnelConfigurationClient("client", () => true, () => "mcp-test", raw => { id = (raw as { requestId: string }).requestId; });
  const lifecycle = { phase: "failed", canActivate: true, canStop: false, healthy: null, ready: null, reason: "host_failed", message: "Fixed host failure.", failurePhase: "host_start", hostFailureCode: "process_create_failed" };
  const work = client.request({ action: "status" });
  client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: id, status: { ...status, lifecycle } });
  assert.equal((await work).lifecycle?.hostFailureCode, "process_create_failed");
  for (const injected of [{ hostFailureCode: "synthetic-secret" }, { failurePhase: "synthetic-secret" }, { rawError: "synthetic-secret" }]) {
    const rejected = client.request({ action: "status" });
    client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: id, status: { ...status, lifecycle: { ...lifecycle, ...injected } } });
    await assert.rejects(rejected, error => error instanceof Error && !error.message.includes("synthetic-secret"));
  }
});
void test("masked write-only fields have no prefill, escape status, and erase DOM input before async transport", () => {
  const html = configurationFields(status);
  assert.match(html, /type="password" autocomplete="new-password" spellcheck="false" value=""/);
  assert.match(html, /&lt;unsafe&gt;/); assert.match(html, /Leave blank/);
  const key = { value: "synthetic-runtime-key-for-testing" }, id = { value: status.tunnelId! }, rotate = { checked: true };
  const root = { querySelector: (selector: string) => selector.includes("runtime") ? key : selector.includes("tunnel-id") ? id : rotate } as unknown as Pick<HTMLElement, "querySelector">;
  const input = takeConfigurationInput(root, status.controller); assert.equal(key.value, ""); assert.equal(input.rotateRuntimeKey, true); assert.ok(input.runtimeKey !== undefined); assert.deepEqual(input.expectedController, status.controller); delete input.runtimeKey;
});

void test("Save accepts a confirmed reply after the former deadline without retaining the key or retrying", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let id = "", sends = 0;
  const client = new TunnelConfigurationClient("client", () => true, () => "mcp-test", raw => { sends++; id = (raw as { requestId: string }).requestId; });
  const input = { action: "save" as const, runtimeKey: "synthetic-runtime-key-for-testing" };
  const work = client.request(input); assert.ok(!Object.hasOwn(input, "runtimeKey"));
  t.mock.timers.tick(45000);
  await assert.rejects(client.request({ action: "status" }), /pending/);
  client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: id, status: { ...status, configured: true, bridgeKeyConfigured: true } });
  assert.equal((await work).configured, true); assert.equal(sends, 1);
  const timedOut = client.request({ action: "save" }); const timeoutCheck = assert.rejects(timedOut, /uncertain/);
  t.mock.timers.tick(CONFIGURATION_TIMEOUT_MS.save); await timeoutCheck; assert.equal(sends, 2);
});

void test("only whitelisted configuration codes become visible messages; arbitrary error text is discarded", async () => {
  let id = ""; const client = new TunnelConfigurationClient("client", () => true, () => "mcp-test", raw => { id = (raw as { requestId: string }).requestId; });
  const work = client.request({ action: "status" });
  client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: id, errorCode: "replacement_required", error: "synthetic-secret-must-never-render" });
  await assert.rejects(work, error => error instanceof Error && /already saved/.test(error.message) && !error.message.includes("synthetic-secret"));
  const unknown = client.request({ action: "status" });
  client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: id, errorCode: "synthetic-secret-must-never-render", error: "synthetic-secret-must-never-render" });
  await assert.rejects(unknown, /not completed/);
});
void test("configuration client uses only private transport, correlates safe replies, scrubs inputs and never retries", async () => {
  let authority = true, sends = 0, id = "";
  const client = new TunnelConfigurationClient("client", () => authority, () => "mcp-test", raw => {
    sends++; id = (raw as { requestId: string }).requestId;
    assert.equal((raw as { kind: string }).kind, "dot-tunnel-configuration");
  });
  const input = { action: "save" as const, tunnelId: status.tunnelId!, runtimeKey: "synthetic-runtime-key-for-testing" };
  const work = client.request(input); assert.ok(!Object.hasOwn(input, "runtimeKey"));
  await assert.rejects(client.request({ action: "status" }), /pending/);
  client.receive({ kind: "dot-tunnel-configuration-status", clientId: "other", requestId: id, status });
  assert.equal(sends, 1);
  client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: id, status }); assert.equal(await work, status);
  const failed = client.request({ action: "status" }); client.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: id, status: { ...status, runtimeKey: "synthetic-do-not-render" } }); await assert.rejects(failed, /not completed/);
  const interrupted = client.request({ action: "status" }); client.disconnected(); await assert.rejects(interrupted, /interrupted/);
  authority = false; await assert.rejects(client.request({ action: "status" })); assert.equal(sends, 3);
});
