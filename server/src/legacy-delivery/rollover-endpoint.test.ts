import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import express from "express";
import request from "supertest";
import type { FoundryClient } from "../../../../foundry-local-api/server/dist/bridge/foundry-client.js";
import { configureMovementGenerationRollover, rolloverEndpointDescriptors } from "./rollover-endpoint.js";

const registry = await import(new URL("../../../../foundry-local-api/server/src/endpoints/registry.ts", import.meta.url).href) as typeof import("../../../../foundry-local-api/server/dist/endpoints/registry.js");
afterEach(() => configureMovementGenerationRollover(undefined));

void test("the AI-owned recovery alias keeps its strict REST and MCP wire contracts in the generic registry", async () => {
  const endpoint = rolloverEndpointDescriptors[0]!;
  const result = {
    status: "completed" as const, replayed: false, oldGeneration: "legacy-generation", newGeneration: "4e30b648-e22a-4e05-80d4-4d87df2f8cb0",
    quarantine: { movementFile: "movement.json", movementBytes: 999, movementSha256: "a".repeat(64), deliveryFile: "queue.json", deliveryBytes: 257, deliverySha256: "b".repeat(64), deliveryItemCount: 0 },
    current: { movementSha256: "c".repeat(64), deliverySha256: "d".repeat(64), cursor: "4e30b648-e22a-4e05-80d4-4d87df2f8cb0:0" }, completedAt: 1,
  };
  const input = { expectedGeneration: "legacy-generation", expectedMovementSha256: "a".repeat(64), idempotencyKey: "rollover-endpoint-0001", confirmation: "quarantine-and-rollover" as const };
  let calls = 0;
  configureMovementGenerationRollover(() => { calls++; return result; });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registry.mountRestEndpoints(router, [endpoint]);
  app.use("/api", router);
  app.use((error: { status?: number }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next;
    response.status(error.status ?? 500).json({ error: true });
  });
  const foundryClient = {} as FoundryClient;
  app.locals["foundryClient"] = foundryClient;
  const rest = await request(app).post(`/api${endpoint.path!}`).send(input);
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.body, result);
  const invalid = await request(app).post(`/api${endpoint.path!}`).send({ ...input, confirmation: "incorrect" });
  assert.equal(invalid.status, 400);
  let callback: ((input: unknown) => Promise<{ structuredContent?: object }>) | undefined;
  const mcp = {
    registerTool: (name: string, _configuration: unknown, handler: typeof callback) => {
      assert.equal(name, "foundry_rollover_movement_store_generation");
      callback = handler;
      return {};
    },
  } as unknown as Parameters<typeof registry.registerMcpTools>[0];
  registry.registerMcpTools(mcp, [endpoint], foundryClient);
  assert.ok(callback);
  assert.deepEqual((await callback(input)).structuredContent, result);
  await assert.rejects(() => callback!({ ...input, unexpected: true }));
  assert.equal(calls, 2);
});
