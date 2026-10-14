/* eslint-disable @typescript-eslint/require-await -- DialogV2 fixtures deliberately preserve its asynchronous method contract. */
import assert from "node:assert/strict";
import test from "node:test";
import { DotTunnelSetupClient, TUNNEL_SETUP_EVENT, registerDotTunnelSetupButton, showDotTunnelSetup, type TunnelSetupStatus } from "./dot-tunnel-setup.js";
import { TunnelConfigurationClient, type TunnelConfigurationStatus } from "./tunnel-configuration.js";

function loadingFixture(t: test.TestContext, options: { delayedRender?: boolean; delayedClose?: boolean; actions?: string[] } = {}) {
  const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const put = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  const notifications: string[] = [], screens: Record<string, unknown>[] = [], toolRequests: { requestId: string; action: string }[] = [], configRequests: { requestId: string; action: string }[] = [];
  put("game", { user: { isGM: true, name: "GM" } }); put("ui", { notifications: { notify: (message: string) => notifications.push(message) } });
  let closeLoading!: () => void, renderLoading!: () => void, finishClosing!: () => void;
  put("foundry", { applications: { api: { DialogV2: { wait: (screen: Record<string, unknown>) => {
    screens.push(screen);
    if ((screen.window as { title: string }).title === "Loading tunnel configuration") return new Promise(resolve => {
      closeLoading = () => { (screen.close as () => void)(); resolve(null); };
      renderLoading = () => (screen.render as (event: unknown, instance: unknown) => void)({}, { close: () => options.delayedClose ? new Promise<void>(finish => { finishClosing = () => { closeLoading(); finish(); }; }) : (closeLoading(), Promise.resolve()) });
      if (!options.delayedRender) renderLoading();
    });
    (screen.close as () => void)(); return Promise.resolve(options.actions?.shift() ?? "close");
  } } } } });
  const configuration = new TunnelConfigurationClient("client", () => true, () => "world", raw => configRequests.push(raw as typeof configRequests[number]));
  const client = new DotTunnelSetupClient("client", () => true, () => true, () => "world", (_event, raw) => toolRequests.push(raw as typeof toolRequests[number]), configuration);
  t.after(() => { client.disconnected(); configuration.disconnected(); });
  const replyTool = (index = 0) => { const request = toolRequests[index]!; client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: request.requestId, status }); };
  const replyConfig = (index = 0) => { const request = configRequests[index]!; configuration.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: request.requestId, status: { configured: true, runtimeKeyConfigured: true, bridgeKeyConfigured: true, controller: { worldId: "world", sceneId: "scene", clientId: "client", userId: "gm" }, activation: "inactive", message: "Verified fixture", lifecycle: { phase: "inactive", canActivate: true, canStop: false, healthy: null, ready: null, reason: "inactive", message: "Verified fixture" } } }); };
  return { client, configuration, screens, notifications, toolRequests, configRequests, close: () => closeLoading(), render: () => renderLoading(), finishClose: () => finishClosing(), replyTool, replyConfig };
}
async function settle() { for (let count = 0; count < 32; count++) await Promise.resolve(); }

void test("opening renders loading immediately and verifies both statuses before showing Save or Activate", async t => {
  const f = loadingFixture(t); const work = showDotTunnelSetup(f.client);
  assert.equal(f.screens.length, 1); assert.equal(f.toolRequests.length, 1); assert.equal(f.configRequests.length, 0);
  assert.match(String(f.screens[0]!.content), /Checking the companion/); assert.ok(!String(f.screens[0]!.content).includes('type="password"'));
  assert.deepEqual((f.screens[0]!.buttons as { action: string }[]).map(button => button.action), ["close"]);
  assert.equal(showDotTunnelSetup(f.client), work); assert.equal(f.toolRequests.length, 1);
  f.replyTool(); await settle(); assert.equal(f.configRequests.length, 1); assert.equal(f.screens.length, 1);
  assert.equal(showDotTunnelSetup(f.client), work); assert.equal(f.configRequests.length, 1);
  f.replyConfig(); await work; assert.equal(f.screens.length, 2);
  const actions = f.screens[1]!.buttons as { action: string; disabled?: boolean }[];
  assert.equal(actions.find(button => button.action === "activate")?.disabled, false); assert.ok(actions.some(button => button.action === "save"));
});
for (const phase of ["tool", "configuration"] as const) {
  void test(`closing while ${phase} status is pending cannot resurrect the dialog or duplicate requests`, async t => {
    const f = loadingFixture(t); const work = showDotTunnelSetup(f.client);
    if (phase === "configuration") { f.replyTool(); await settle(); assert.equal(f.configRequests.length, 1); }
    f.close(); await settle(); assert.equal(showDotTunnelSetup(f.client), work);
    if (phase === "tool") f.replyTool(); else f.replyConfig();
    await work; assert.equal(f.screens.length, 1); assert.equal(f.toolRequests.length, 1); assert.equal(f.configRequests.length, phase === "tool" ? 0 : 1);
    assert.ok(f.toolRequests.every(request => request.action === "status")); assert.ok(f.configRequests.every(request => request.action === "status"));
  });
}
void test("loading failure closes progress and exposes only a fixed status error", async t => {
  const f = loadingFixture(t); f.client.request = () => Promise.reject(new Error("synthetic-private-error-do-not-display"));
  await showDotTunnelSetup(f.client); assert.equal(f.screens.length, 1); assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0]!, /status could not be verified/); assert.ok(!f.notifications[0]!.includes("synthetic-private"));
});
void test("a failed status response after close has no late screen or error notification", async t => {
  const f = loadingFixture(t); const work = showDotTunnelSetup(f.client); f.close(); await settle(); f.client.disconnected();
  await work; assert.equal(f.screens.length, 1); assert.equal(f.notifications.length, 0); assert.equal(f.configRequests.length, 0);
});
void test("status completing before the loading render still closes that window before showing controls", async t => {
  const f = loadingFixture(t, { delayedRender: true }); const work = showDotTunnelSetup(f.client);
  f.replyTool(); await settle(); f.replyConfig(); await settle(); assert.equal(f.screens.length, 1);
  f.render(); await work; assert.equal(f.screens.length, 2);
});
void test("Close during the programmatic close animation still abandons the verified result", async t => {
  const f = loadingFixture(t, { delayedClose: true }); const work = showDotTunnelSetup(f.client);
  f.replyTool(); await settle(); f.replyConfig(); await settle(); assert.equal(f.screens.length, 1);
  (f.screens[0]!.buttons as { callback(): unknown }[])[0]!.callback(); f.finishClose();
  await work; assert.equal(f.screens.length, 1);
});
void test("Refresh status displays progress and closing it prevents the refreshed controls from reopening", async t => {
  const f = loadingFixture(t, { actions: ["status"] }); const work = showDotTunnelSetup(f.client);
  f.replyTool(); await settle(); f.replyConfig(); await settle();
  assert.equal(f.screens.length, 3); assert.equal((f.screens[2]!.window as { title: string }).title, "Loading tunnel configuration");
  assert.equal(f.toolRequests.length, 2); f.close(); f.replyTool(1); await work;
  assert.equal(f.screens.length, 3); assert.equal(f.configRequests.length, 1);
});

const status: TunnelSetupStatus = { enabled: true, phase: "different_version", requiredVersion: "v0.0.16", installedVersion: "v0.0.15", platform: "windows-amd64", message: "<unsafe>" };
for (const diagnosticStorage of ["saved", "unavailable"] as const) {
  void test(`diagnostic ${diagnosticStorage} receipt shows fixed metadata without claiming remote readiness`, async t => {
    const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const put = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
    put("game", { user: { isGM: true, name: "GM" } }); put("ui", { notifications: { notify() {} } });
    let html = "";
    put("foundry", { applications: { api: { DialogV2: { wait: (options: Record<string, unknown>) => {
      const loading = automaticLoading(options); if (loading) return loading;
      html = String(options.content); (options.close as () => void)(); return Promise.resolve("close");
    } } } } });
    const diagnosticId = "attempt-01234567-89ab-4def-8123-0123456789ab";
    const configurationStatus: TunnelConfigurationStatus = { configured: true, runtimeKeyConfigured: true, bridgeKeyConfigured: true,
      controller: { worldId: "mcp-test", sceneId: "scene", clientId: "client", userId: "gm" }, activation: "inactive", message: "Verified status.",
      lifecycle: { phase: "failed", canActivate: true, canStop: false, healthy: true, ready: true, reason: "host_failed", message: "Fixed host failure.", failurePhase: "host_start", hostFailureCode: "process_create_failed", diagnosticId, diagnosticStorage } };
    const configuration = new TunnelConfigurationClient("client", () => true, () => "mcp-test", raw => {
      configuration.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: (raw as { requestId: string }).requestId, status: configurationStatus });
    });
    const client = new DotTunnelSetupClient("client", () => true, () => true, () => "mcp-test", (_event, raw) => {
      client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: (raw as { requestId: string }).requestId, status });
    }, configuration);
    await showDotTunnelSetup(client);
    assert.ok(html.includes(diagnosticId)); assert.ok(html.includes("process_create_failed")); assert.ok(html.includes("host_start"));
    assert.ok(html.includes("Local health: Healthy. Local readiness: Ready."));
    assert.ok(html.includes("Local readiness does not confirm a ChatGPT connection or event delivery."));
    assert.ok(!html.includes("ChatGPT is connected"));
    if (diagnosticStorage === "saved") {
      assert.ok(html.includes(`%LOCALAPPDATA%\\FoundryDot\\diagnostic-${diagnosticId}.json`)); assert.ok(html.includes("Paste this path into File Explorer"));
    } else { assert.ok(html.includes("could not be saved")); assert.ok(html.includes("No diagnostic file was confirmed")); assert.ok(!html.includes("Saved local diagnostic:")); }
    assert.match(html, /type="password" autocomplete="new-password" spellcheck="false" value=""/);
  });
}
// Existing interaction fixtures focus on verified controls. Explicit deferred
// loading/cancellation coverage below exercises this new preliminary view.
function automaticLoading(options: Record<string, unknown>): Promise<unknown> | undefined {
  if ((options.window as { title: string }).title !== "Loading tunnel configuration") return;
  return new Promise(resolve => { (options.render as (event: unknown, instance: unknown) => void)({}, { close: async () => { (options.close as () => void)(); resolve(null); } }); });
}
void test("verified activation and Stop require separate confirmation and send only current scope over private transport", async t => {
  const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const set = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  set("game", { user: { isGM: true, name: "GM" } }); set("ui", { notifications: { notify() {} } });
  let current: TunnelConfigurationStatus = { configured: true, runtimeKeyConfigured: true, bridgeKeyConfigured: true, controller: { worldId: "mcp-test", sceneId: "scene", clientId: "client", userId: "gm" }, activation: "inactive", message: "synthetic", lifecycle: { phase: "inactive", canActivate: true, canStop: false, healthy: null, ready: null, reason: "inactive", message: "synthetic" } };
  const actions: Record<string, unknown>[] = [];
  const configuration = new TunnelConfigurationClient("client", () => true, () => "mcp-test", payload => {
    const request = payload as Record<string, unknown>; actions.push(request);
    if (request["action"] === "activate") current = { ...current, activation: "active", lifecycle: { ...current.lifecycle!, phase: "running", canActivate: false, canStop: true, healthy: true, ready: false, reason: "running" } };
    if (request["action"] === "stop") current = { ...current, activation: "inactive", lifecycle: { ...current.lifecycle!, phase: "inactive", canActivate: false, canStop: false, healthy: null, ready: null, reason: "inactive" } };
    queueMicrotask(() => configuration.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: request["requestId"], status: current }));
  });
  const client = new DotTunnelSetupClient("client", () => true, () => true, () => "mcp-test", (_event, payload) => queueMicrotask(() => client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: (payload as { requestId: string }).requestId, status })), configuration);
  const choices = ["activate", true, "stop", true, "close"]; let screens = 0;
  set("foundry", { applications: { api: { DialogV2: { wait: async (options: Record<string, unknown>) => { const loading = automaticLoading(options); if (loading) return loading;
    const choice = choices.shift();
    if (typeof choice === "string" && choice !== "close") {
      const button = (options["buttons"] as { action: string; disabled?: boolean }[]).find(button => button.action === choice)!;
      assert.equal(button.disabled, false); screens++;
      assert.ok(String(options["content"]).includes("Local readiness does not confirm"));
    }
    (options["close"] as () => void)(); return choice;
  } } } } });
  await showDotTunnelSetup(client);
  assert.equal(screens, 2); assert.deepEqual(actions.map(action => action["action"]), ["status", "activate", "stop"]);
  for (const action of actions.slice(1)) {
    assert.equal(action["confirmed"], true); assert.deepEqual(action["expectedController"], current.controller);
    assert.deepEqual(Object.keys(action).sort(), ["action", "confirmed", "expectedController", "kind", "requestId", "worldId"]);
  }
});
void test("setup client is inert, checks GM connection, correlates replies and bounds one request", async () => {
  let authority = false, connected = true; const sent: { event: string; payload: { requestId: string; action: string; confirmed?: boolean } }[] = [];
  const client = new DotTunnelSetupClient("client", () => authority, () => connected, () => "world", (event, payload) => sent.push({ event, payload: payload as typeof sent[number]["payload"] }));
  assert.equal(sent.length, 0); await assert.rejects(client.request("install")); authority = true; connected = false; await assert.rejects(client.request("install")); connected = true;
  const work = client.request("install"); assert.equal(sent.length, 1); assert.equal(sent[0]!.event, TUNNEL_SETUP_EVENT); assert.deepEqual(Object.keys(sent[0]!.payload).sort(), ["action", "confirmed", "requestId", "worldId"]); assert.equal(sent[0]!.payload.confirmed, true);
  await assert.rejects(client.request("status"), /pending/); assert.equal(client.receive({ kind: "unrelated" }), false);
  client.receive({ kind: "dot-tunnel-tool-status", clientId: "other", requestId: sent[0]!.payload.requestId, status }); await assert.rejects(client.request("status"), /pending/);
  client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: sent[0]!.payload.requestId, status }); assert.equal(await work, status);
  const disconnected = client.request("status"); client.disconnected(); await assert.rejects(disconnected, /interrupted/);
});

void test("init keeps the lower-level sidebar shortcut without duplicating the AI Dungeon Master settings menu", t => {
  const saved = new Map(["game", "ui", "foundry", "Hooks"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const setGlobal = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  let menus = 0, hooks = 0;
  setGlobal("game", { get user() { throw new Error("game.user is unavailable during init"); }, settings: { registerMenu: () => { menus++; } } });
  setGlobal("Hooks", { on: (event: string) => { assert.equal(event, "renderSettings"); hooks++; } });
  registerDotTunnelSetupButton(() => undefined);
  assert.equal(menus, 0); assert.equal(hooks, 1);
});
void test("integrated screen clears write-only entry, confirms replacement, saves privately and never activates", async t => {
  const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const setGlobal = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  setGlobal("game", { user: { isGM: true, name: "GM" } }); setGlobal("ui", { notifications: { notify() {} } });
  const configuration: TunnelConfigurationStatus = { configured: false, runtimeKeyConfigured: true, bridgeKeyConfigured: false, tunnelId: `tunnel_${"a".repeat(32)}`, controller: { worldId: "mcp-test", sceneId: "scene", clientId: "client", userId: "gm" }, activation: "inactive", message: "Separate activation required." };
  const key = { value: "synthetic-only-runtime-entry" }, tunnel = { value: configuration.tunnelId! }, rotate = { checked: true };
  const root = { querySelector: (selector: string) => selector.includes("runtime-key") ? key : selector.includes("tunnel-id") ? tunnel : rotate };
  let dialogs = 0, configSaves = 0; const toolActions: string[] = [];
  setGlobal("foundry", { applications: { api: { DialogV2: { wait: async (options: Record<string, unknown>) => { const loading = automaticLoading(options); if (loading) return loading;
    dialogs++;
    if (dialogs === 1) {
      (options.render as (event: unknown, instance: unknown) => void)({}, { element: root });
      const buttons = options.buttons as { action: string; disabled?: boolean; callback: () => unknown }[];
      assert.equal(buttons.find(button => button.action === "activate")?.disabled, true);
      assert.ok(!String(options.content).includes(key.value));
      const result = buttons.find(button => button.action === "save")!.callback();
      assert.equal(key.value, ""); (options.close as () => void)(); return result;
    }
    if (String((options.window as { title: string }).title).includes("Saving private")) {
      assert.ok(!String(options.content).includes("synthetic-only-runtime-entry"));
      return new Promise(resolve => { (options.render as (event: unknown, instance: unknown) => void)({}, { close: async () => { resolve(null); } }); });
    }
    (options.close as () => void)(); return dialogs === 2 ? true : "close";
  } } } } });
  const configClient = new TunnelConfigurationClient("client", () => true, () => "mcp-test", raw => {
    const request = raw as { requestId: string; action: string; rotateRuntimeKey?: boolean };
    if (request.action === "save") { configSaves++; assert.equal(key.value, ""); assert.equal(request.rotateRuntimeKey, true); }
    configClient.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: request.requestId, status: request.action === "save" ? { ...configuration, configured: true, bridgeKeyConfigured: true } : configuration });
  });
  const tools = new DotTunnelSetupClient("client", () => true, () => true, () => "mcp-test", (_event, raw) => {
    const request = raw as { requestId: string; action: string }; toolActions.push(request.action);
    tools.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: request.requestId, status });
  }, configClient);
  await showDotTunnelSetup(tools); assert.equal(configSaves, 1); assert.equal(dialogs, 4); assert.deepEqual(toolActions, ["status"]);
});
void test("configuration failure preserves installer controls and exposes no Save or secret fields", async t => {
  const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const setGlobal = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  setGlobal("game", { user: { isGM: true, name: "GM" } }); setGlobal("ui", { notifications: { notify() {} } });
  let shown = false;
  setGlobal("foundry", { applications: { api: { DialogV2: { wait: async (options: Record<string, unknown>) => { const loading = automaticLoading(options); if (loading) return loading;
    shown = true; const actions = (options.buttons as { action: string }[]).map(button => button.action);
    assert.ok(actions.includes("install") && actions.includes("status") && !actions.includes("save"));
    assert.match(String(options.content), /Private configuration is unavailable/);
    assert.ok(!String(options.content).includes('type="password"'));
    (options.close as () => void)(); return "close";
  } } } } });
  const configuration = new TunnelConfigurationClient("client", () => true, () => "mcp-test", raw => {
    const input = raw as { requestId: string }; configuration.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: input.requestId, error: "synthetic-private-storage-unavailable" });
  });
  const client = new DotTunnelSetupClient("client", () => true, () => true, () => "mcp-test", (_event, raw) => {
    const input = raw as { requestId: string }; client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: input.requestId, status });
  }, configuration);
  await showDotTunnelSetup(client); assert.equal(shown, true);
});
void test("failed Save displays its fixed reason, clears the key, and preserves installer/status controls", async t => {
  const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const setGlobal = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  setGlobal("game", { user: { isGM: true, name: "GM" } });
  const messages: string[] = []; setGlobal("ui", { notifications: { notify: (message: string) => messages.push(message) } });
  const configuration: TunnelConfigurationStatus = { configured: true, runtimeKeyConfigured: true, bridgeKeyConfigured: true, tunnelId: `tunnel_${"a".repeat(32)}`, controller: { worldId: "mcp-test", sceneId: "scene", clientId: "client", userId: "gm" }, activation: "inactive", message: "Separate activation." };
  const key = { value: "synthetic-new-runtime-key" };
  const root = { querySelector: (selector: string) => selector.includes("runtime-key") ? key : selector.includes("tunnel-id") ? { value: configuration.tunnelId } : { checked: false } };
  let dialogs = 0;
  setGlobal("foundry", { applications: { api: { DialogV2: { wait: async (options: Record<string, unknown>) => { const loading = automaticLoading(options); if (loading) return loading;
    dialogs++;
    if (dialogs === 1) {
      (options.render as (event: unknown, instance: unknown) => void)({}, { element: root });
      const result = (options.buttons as { action: string; callback(): unknown }[]).find(button => button.action === "save")!.callback();
      assert.equal(key.value, ""); (options.close as () => void)(); return result;
    }
    if (dialogs === 2) return new Promise(resolve => { (options.render as (event: unknown, instance: unknown) => void)({}, { close: async () => { resolve(null); } }); });
    assert.match(String(options.content), /runtime key is already saved/); assert.ok(!String(options.content).includes('type="password"'));
    assert.ok(!(options.buttons as { action: string }[]).some(button => button.action === "save"));
    (options.close as () => void)(); return "close";
  } } } } });
  const configClient = new TunnelConfigurationClient("client", () => true, () => "mcp-test", raw => {
    const request = raw as { requestId: string; action: string };
    configClient.receive({ kind: "dot-tunnel-configuration-status", clientId: "client", requestId: request.requestId, ...(request.action === "save" ? { errorCode: "replacement_required", error: "synthetic-key-do-not-display" } : { status: configuration }) });
  });
  const tools = new DotTunnelSetupClient("client", () => true, () => true, () => "mcp-test", (_event, raw) => {
    const request = raw as { requestId: string }; tools.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: request.requestId, status });
  }, configClient);
  await showDotTunnelSetup(tools); assert.equal(dialogs, 3); assert.equal(key.value, "");
  assert.ok(messages.some(message => message.includes("runtime key is already saved"))); assert.ok(!JSON.stringify(messages).includes("synthetic-key"));
});
void test("malformed setup controls reject pending requests instead of rendering arbitrary values", async () => {
  let id = ""; const client = new DotTunnelSetupClient("client", () => true, () => true, () => "world", (_event, payload) => { id = (payload as { requestId: string }).requestId; });
  const work = client.request("status"); client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: id, status: { ...status, installedVersion: { html: "unsafe" } } }); await assert.rejects(work, /interrupted/);
});
void test("dialog escapes status and canceled install does not send an installation request", async t => {
  const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const setGlobal = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  setGlobal("game", { user: { isGM: true, name: "GM" } }); setGlobal("ui", { notifications: { notify() {} } }); const dialogs: Record<string, unknown>[] = [], replies = ["install", false, "close"];
  setGlobal("foundry", { applications: { api: { DialogV2: { wait: async (options: Record<string, unknown>) => { const loading = automaticLoading(options); if (loading) return loading; dialogs.push(options); (options.close as (() => void) | undefined)?.(); return replies.shift(); } } } } });
  const actions: string[] = [];
  const client = new DotTunnelSetupClient("client", () => true, () => true, () => "world", (_event, payload) => { const input = payload as { requestId: string; action: string }; actions.push(input.action); client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: input.requestId, status }); });
  await showDotTunnelSetup(client); assert.deepEqual(actions, ["status"]); assert.match(String(dialogs[0]!.content), /&lt;unsafe&gt;/); assert.ok(!String(dialogs[0]!.content).includes("<unsafe>"));
  setGlobal("game", { user: { isGM: false, name: "Player" } }); await showDotTunnelSetup(client); assert.deepEqual(actions, ["status"]);
});
void test("one progress dialog survives a stalled install and reentry never requests another install", async t => {
  const saved = new Map(["game", "ui", "foundry"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const setGlobal = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  setGlobal("game", { user: { isGM: true, name: "GM" } }); setGlobal("ui", { notifications: { notify() {} } });
  const actions: string[] = [], dialogs: Record<string, unknown>[] = []; let installId = "", reached!: () => void;
  const installing = new Promise<void>(resolve => { reached = resolve; });
  setGlobal("foundry", { applications: { api: { DialogV2: { wait: async (options: Record<string, unknown>) => { const loading = automaticLoading(options); if (loading) return loading;
    dialogs.push(options);
    if (String((options.window as { title: string }).title).includes("working")) return new Promise(resolve => { (options.render as (event: unknown, instance: unknown) => void)({}, { close: async () => { resolve(null); } }); });
    (options.close as (() => void))(); return dialogs.length === 1 ? "install" : dialogs.length === 2 ? true : "close";
  } } } } });
  const client = new DotTunnelSetupClient("client", () => true, () => true, () => "world", (_event, payload) => {
    const input = payload as { action: string; requestId: string }; actions.push(input.action);
    if (input.action === "install") { installId = input.requestId; reached(); return; }
    client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: input.requestId, status });
  });
  const first = showDotTunnelSetup(client); await installing; assert.equal(showDotTunnelSetup(client), first);
  assert.deepEqual(actions, ["status", "install"]); assert.equal(dialogs.length, 3);
  assert.match(String(dialogs[2]!.content), /Installation is in progress/); assert.deepEqual((dialogs[2]!.buttons as { action: string }[]).map(button => button.action), ["hide"]);
  client.receive({ kind: "dot-tunnel-tool-status", clientId: "client", requestId: installId, status: { ...status, phase: "error", message: "Synthetic offline failure" } });
  await first; assert.deepEqual(actions, ["status", "install"]);
});
