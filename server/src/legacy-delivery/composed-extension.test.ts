import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import request from "supertest";
import type { RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMovementEvent } from "../../../../foundry-local-api/shared/dist/index.js";
import { registerExtension } from "../dot-extension.js";
import { MovementEventStore } from "./test-api-fixtures.js";
import { AiGmDeliveryService } from "./ai-gm-delivery.js";
import type { AnyEndpointDescriptor, LegacyDeliveryContext } from "./api-contract.js";

interface HostFixture {
  readonly context: LegacyDeliveryContext;
  routeSnapshot(): { path: string; handler: RequestHandler }[];
  shutdown(): Promise<void>;
}
const hostModule = await import(new URL("../../../../foundry-local-api/server/src/extensions/host.ts", import.meta.url).href) as {
  ApiExtensionHost: new (options: unknown) => HostFixture;
};
const catalog = await import(new URL("../../../../foundry-local-api/server/src/extensions/endpoints.ts", import.meta.url).href) as {
  extensionEndpoints: {
    snapshot(): AnyEndpointDescriptor[];
    bindMcp(server: McpServer, client: unknown): () => void;
  };
};
const api = await import(new URL("../../../../foundry-local-api/server/src/app.ts", import.meta.url).href) as typeof import("../../../../foundry-local-api/server/dist/app.js");

void test("the full AI extension loads actual legacy aliases into the authenticated API and live MCP catalog, then revokes them", async t => {
  const originalConfig = process.env["FOUNDRY_DOT_CONFIG"];
  delete process.env["FOUNDRY_DOT_CONFIG"];
  t.after(() => {
    if (originalConfig === undefined) delete process.env["FOUNDRY_DOT_CONFIG"];
    else process.env["FOUNDRY_DOT_CONFIG"] = originalConfig;
  });
  const directory = mkdtempSync(join(tmpdir(), "ai-extension-composed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queuePath = join(directory, "ai-gm-deliveries.json"), movementPath = join(directory, "movement-events.json");
  let store = new MovementEventStore(movementPath);
  store.append(buildMovementEvent({ eventId: "composed-movement-001", sceneId: "scene", tokenId: "token", userId: "user", timestamp: 1, waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }], regions: [] }));
  const queue = new AiGmDeliveryService(queuePath, "codex-active-ai-gm");
  queue.initializeReconciliationWatermark(store, 0);
  queue.reconcileMovementStore(store);
  const saved = readFileSync(queuePath, "utf8"), deliveryId = queue.list()[0]!.id;
  let calls = 0, movementAttached = false;
  const channels = new Set<string>();
  const host = new hostModule.ApiExtensionHost({
    gateway: {
      getClient: () => null, getVerifiedFoundryIdentity: () => null, send: () => false,
      registerPrivateChannel: (kind: string) => { channels.add(kind); return () => { channels.delete(kind); }; },
      onConnectionEstablished: () => () => undefined, onConnectionLost: () => () => undefined,
    },
    foundryClient: { call: () => { calls++; return Promise.reject(new Error("Inactive extension must not call Foundry.")); } },
    runtimeRoot: pathToFileURL(`${directory}/`), moduleRoot: new URL("file:///C:/synthetic/api/"),
    bindHost: "127.0.0.1", administrativeCredentialSha256: "0".repeat(64),
    movement: {
      path: movementPath, getStore: () => store, diagnose: () => MovementEventStore.diagnose(movementPath),
      reloadStore: () => { store = new MovementEventStore(movementPath); },
      onRecord: () => { movementAttached = true; return () => { movementAttached = false; }; },
    },
  });
  t.after(() => host.shutdown());
  registerExtension(host.context);
  const names = ["foundry_list_ai_gm_deliveries", "foundry_get_ai_gm_delivery", "foundry_rollover_movement_store_generation"];
  assert.deepEqual(catalog.extensionEndpoints.snapshot().map(({ name }) => name), names);
  assert.deepEqual([...channels], ["dot-tunnel-configuration"]);
  assert.equal(readFileSync(queuePath, "utf8"), saved);
  assert.equal(calls, 0);
  const appOptions = { isDevelopment: false, apiKey: "synthetic-composed-key", corsAllowedOrigins: [], rateLimitWindowMs: 60_000, rateLimitMax: 100, requestLogger: () => undefined, extensionRoutes: host.routeSnapshot() };
  const app = api.createApp(appOptions);
  await request(app).get(`/api/ai-gm/deliveries/${deliveryId}`).expect(401);
  const fetched = await request(app).get(`/api/ai-gm/deliveries/${deliveryId}`).set("x-api-key", "synthetic-composed-key").expect(200);
  assert.equal((fetched.body as { id: string }).id, deliveryId);
  await request(app).get("/api/ai-gm/deliveries/missing").set("x-api-key", "synthetic-composed-key").expect(404);
  await request(app).post("/dot/mcp").send({ method: "events/list" }).expect(503);
  const server = new McpServer({ name: "composed-ai-extension", version: "1" });
  const unbind = catalog.extensionEndpoints.bindMcp(server, {});
  const client = new Client({ name: "composed-ai-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), names);
    const detail = await client.callTool({ name: "foundry_get_ai_gm_delivery", arguments: { deliveryId } });
    assert.equal((detail.structuredContent as { id: string }).id, deliveryId);
    const listed = await client.callTool({ name: "foundry_list_ai_gm_deliveries", arguments: {} });
    assert.equal((listed.structuredContent as { items: unknown[] }).items.length, 1);
    const missing = await client.callTool({ name: "foundry_get_ai_gm_delivery", arguments: { deliveryId: "missing" } });
    assert.equal(missing.isError, true);
    await host.shutdown();
    assert.deepEqual((await client.listTools()).tools, []);
    await request(app).get(`/api/ai-gm/deliveries/${deliveryId}`).set("x-api-key", "synthetic-composed-key").expect(404);
    assert.equal(movementAttached, false);
    assert.equal(channels.size, 0);
    assert.equal(readFileSync(queuePath, "utf8"), saved);
    assert.equal(calls, 0);
  } finally {
    unbind(); await client.close(); await server.close();
  }
});
