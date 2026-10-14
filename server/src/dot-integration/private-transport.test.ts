/* Synthetic async mock adapters intentionally resolve synchronously. */
/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type { GenericBridge, EventSender } from "./api-contract.js";
const { BRIDGE_PROTOCOL_VERSION } = await import(new URL("../../../../foundry-local-api/shared/src/index.ts", import.meta.url).href) as unknown as { BRIDGE_PROTOCOL_VERSION: string };
interface TestGateway extends GenericBridge {
  onMessage(handler: () => void): void;
  registerPrivateChannel(kind: string, handler: (raw: unknown, sender: EventSender, current: () => boolean) => Promise<void>): () => void;
  close(): Promise<void>;
}
interface TestGatewayOptions {
  foundrySessionVerifier: { verify(): Promise<{ ok: true; identity: { worldId: string; userId: string; userName: string; role: number; isGM: boolean } }> };
  bindHost: string; allowedFoundryOrigins: string[];
}
const { BridgeGateway } = await import(new URL("../../../../foundry-local-api/server/src/bridge/gateway.ts", import.meta.url).href) as unknown as { BridgeGateway: new (server: http.Server, options: TestGatewayOptions) => TestGateway };
function rawText(raw: RawData): string { return Array.isArray(raw) ? Buffer.concat(raw).toString() : raw instanceof ArrayBuffer ? Buffer.from(raw).toString() : raw.toString(); }
import { ProtectedTunnelConfigurationStorage, TunnelConfigurationService, type TunnelConfigurationStatus } from "./tunnel-configuration.js";
void test("private configuration frames bypass every ordinary bridge listener, including malformed private schemas", async () => {
  const server = http.createServer();
  const gateway = new BridgeGateway(server, { foundrySessionVerifier: { verify: async () => ({ ok: true, identity: { worldId: "mcp-test", userId: "gm", userName: "GM", role: 4, isGM: true } }) }, bindHost: "127.0.0.1", allowedFoundryOrigins: ["http://localhost:30000"] });
  let ordinary = 0, sensitive = 0, complete!: () => void;
  const handled = new Promise<void>(resolve => { complete = resolve; });
  gateway.onMessage(() => { ordinary++; });
  gateway.registerPrivateChannel("dot-tunnel-configuration", async (raw: unknown, sender: { lane: string }, current: () => boolean) => {
    assert.equal(sender.lane, "gm"); assert.equal(current(), true); assert.ok(raw && typeof raw === "object");
    sensitive++; if (sensitive === 2) complete();
  });
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { origin: "http://localhost:30000" });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    const negotiated = new Promise<{ accepted: boolean }>(resolve => socket!.once("message", raw => resolve(JSON.parse(rawText(raw)) as { accepted: boolean })));
    socket.send(JSON.stringify({ kind: "hello", browserSessionId: "browser-session", worldId: "mcp-test", identity: { clientId: "client", userId: "gm", userName: "GM", isGM: true, lane: "gm", optedIn: true }, versions: { protocolVersion: BRIDGE_PROTOCOL_VERSION, foundryVersion: "14.368", systemId: "dnd5e", systemVersion: "6.0.3", moduleVersion: "0.1.0", transport: "websocket" }, capabilities: ["dotSetupScope"] }));
    assert.equal((await negotiated).accepted, true);
    socket.send('{"kind":"dot-tunnel-configuration","runtimeKey":"synthetic-truncated-value');
    socket.send(JSON.stringify({ kind: "dot-tunnel-configuration", runtimeKey: "synthetic-test-value-only", action: "save" }));
    socket.send(JSON.stringify({ kind: "dot-tunnel-configuration", runtimeKey: "synthetic-malformed-test-value", extra: true }));
    await handled; assert.equal(ordinary, 0); assert.equal(sensitive, 2);
  } finally { socket?.terminate(); await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

void test("verified private WebSocket Save commits synthetic storage and returns safe status/errors without event fanout", async t => {
  const root = mkdtempSync(join(tmpdir(), "foundry-private-transport-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = http.createServer();
  const identity = { worldId: "mcp-test", userId: "gm", userName: "GM", role: 4, isGM: true };
  const gateway = new BridgeGateway(server, { foundrySessionVerifier: { verify: async () => ({ ok: true, identity }) }, bindHost: "127.0.0.1", allowedFoundryOrigins: ["http://localhost:30000"] });
  const scope = { worldId: "mcp-test", sceneId: "scene", userId: "gm", clientId: "client" };
  const service = new TunnelConfigurationService(new ProtectedTunnelConfigurationStorage(root, () => undefined), gateway, async () => scope);
  gateway.registerPrivateChannel("dot-tunnel-configuration", (raw: unknown, sender: { clientId: string; userId: string; lane: string }, current: () => boolean) => service.handle(raw, sender, current));
  let ordinary = 0; gateway.onMessage(() => { ordinary++; });
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { origin: "http://localhost:30000" });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    const negotiated = new Promise<{ accepted: boolean }>(resolve => socket!.once("message", raw => resolve(JSON.parse(rawText(raw)) as { accepted: boolean })));
    socket.send(JSON.stringify({ kind: "hello", browserSessionId: "browser-session", worldId: "mcp-test", identity: { clientId: "client", userId: "gm", userName: "GM", isGM: true, lane: "gm", optedIn: true }, versions: { protocolVersion: BRIDGE_PROTOCOL_VERSION, foundryVersion: "14.368", systemId: "dnd5e", systemVersion: "6.0.3", moduleVersion: "0.1.0", transport: "websocket" }, capabilities: ["dotSetupScope"] }));
    assert.equal((await negotiated).accepted, true);
    const request = async (extra: Record<string, unknown>) => {
      const requestId = randomUUID();
      const reply = new Promise<{ requestId: string; status?: TunnelConfigurationStatus; errorCode?: string }>(resolve => socket!.once("message", raw => {
        assert.ok(!rawText(raw).includes("synthetic-transport-runtime-key")); resolve(JSON.parse(rawText(raw)) as { requestId: string; status?: TunnelConfigurationStatus; errorCode?: string });
      }));
      socket!.send(JSON.stringify({ kind: "dot-tunnel-configuration", requestId, worldId: "mcp-test", action: "save", tunnelId: `tunnel_${"a".repeat(32)}`, expectedController: scope, ...extra }));
      const result = await reply; assert.equal(result.requestId, requestId); return result;
    };
    assert.equal((await request({ runtimeKey: "bad key" })).errorCode, "invalid_input");
    assert.equal((await request({ runtimeKey: "synthetic-transport-runtime-key" })).status?.configured, true);
    assert.equal(readFileSync(join(root, "runtime-key.txt"), "utf8"), "synthetic-transport-runtime-key");
    assert.equal((await request({ runtimeKey: "synthetic-transport-runtime-key-new" })).errorCode, "replacement_required");
    assert.equal(ordinary, 0);
  } finally { socket?.terminate(); await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
