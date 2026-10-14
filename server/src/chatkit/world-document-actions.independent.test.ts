import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ChatKitWorldDocumentActions, worldSourceRevision } from "./world-document-actions.js";
import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";

void test("independent: actual backend source hashes interoperate with adapter writes, browser review and independently verified deletion", async () => {
  const imported: unknown = await import(
    new URL("../../../../foundry-local-api/module/src/commands/world-documents.ts", import.meta.url)
      .href
  );
  const backend = imported as {
    readWorldDocument: (input: unknown) => Promise<AiDmJsonValue>;
    applyWorldDocument: (input: unknown) => Promise<AiDmJsonValue>;
  };
  const importedUi: unknown = await import(
    new URL("../../../module/src/ai-dungeon-master/world-review.ts", import.meta.url).href
  );
  const ui = importedUi as {
    validateWorldReview: (
      value: unknown,
      scope: { worldId: string; userId: string; threadId: string },
    ) => Promise<unknown>;
  };
  const data: Record<string, unknown> = {
    _id: "actor",
    name: "Old",
    description: "reference data ".repeat(1000),
    flags: { world: { Zebra: 1, alpha: 2, Ä: 3 } },
    _stats: { modifiedTime: 1 },
  };
  let effects = 0;
  const docs = new Map<string, object>();
  const actor = {
    id: "actor",
    getEmbeddedCollection: () =>
      new Map([["item", { id: "item", toObject: () => ({ _id: "item", name: "Shield" }) }]]),
    toObject: () => structuredClone(data),
    update: (changes: Record<string, unknown>) => {
      effects++;
      Object.assign(data, changes);
      return Promise.resolve();
    },
    delete: () => {
      effects++;
      docs.delete("actor");
      return Promise.resolve();
    },
  };
  docs.set("actor", actor);
  const liveGm = { isGM: true, active: true };
  Object.assign(globalThis, {
    game: {
      world: { id: "world" },
      user: liveGm,
      users: new Map([["gm", liveGm]]),
      collections: new Map([["Actor", docs]]),
    },
  });
  const tools = [
    "foundry_get_actor",
    "foundry_update_actor",
    "foundry_delete_actor",
    "foundry_list_actor_items",
    "foundry_get_world_document",
    "foundry_apply_world_document",
  ].map((name) => ({ name, inputSchema: { type: "object" } }));
  const client: FoundryLocalApiMcpClient = {
    listTools: () => Promise.resolve(tools),
    callTool: ({ name, arguments: args }) => {
      if (name === "foundry_get_world_document") return backend.readWorldDocument(args);
      if (name === "foundry_apply_world_document") return backend.applyWorldDocument(args);
      throw new Error("Unrestricted raw tool dispatch is forbidden in this fixture");
    },
  };
  const gm = {
    clientId: "fixture",
    worldId: "world",
    userId: "gm",
    isGm: true,
    lane: "gm" as const,
  };
  const scope = { worldId: "world", userId: "gm", threadId: "thread" };
  const authority = {
    worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) },
  };
  const db = new DatabaseSync(":memory:");
  const service = new ChatKitWorldDocumentActions(client, db, () => Promise.resolve());
  const signal = new AbortController().signal;
  try {
    const read = (await service.request(
      gm,
      scope,
      "read",
      { toolId: "foundry_get_actor", args: { id: "actor" } },
      undefined,
      signal,
    )) as Record<string, AiDmJsonValue>;
    assert.equal(read["revision"], worldSourceRevision(data));
    const list = (await service.request(
      gm,
      scope,
      "read",
      { toolId: "foundry_list_actor_items", args: { actorId: "actor" } },
      undefined,
      signal,
    )) as Record<string, AiDmJsonValue>;
    assert.equal(list["parentId"], "actor");
    assert.equal((list["documents"] as AiDmJsonValue[]).length, 1);
    const updated = (await service.request(
      gm,
      scope,
      "write",
      {
        toolId: "foundry_update_actor",
        args: { id: "actor", changes: { name: "New" } },
        actionId: "update",
        expectedRevision: read["revision"],
      },
      authority,
      signal,
    )) as Record<string, unknown>;
    assert.equal(updated["status"], "completed");
    assert.ok(
      Buffer.byteLength(JSON.stringify(updated)) <= 24_000,
      "Supported completed write must return a bounded model receipt",
    );
    assert.equal(data["name"], "New");
    await service.request(
      gm,
      scope,
      "write",
      {
        toolId: "foundry_delete_actor",
        args: { id: "actor" },
        actionId: "delete",
        expectedRevision: worldSourceRevision(data),
      },
      authority,
      signal,
    );
    const review = (await service.browser(
      gm,
      { kind: "world", threadId: "thread", actionId: "delete" },
      signal,
    )) as Record<string, unknown>;
    await ui.validateWorldReview(review, scope);
    assert.equal(effects, 1);
    const approved = (await service.browser(
      gm,
      {
        kind: "world",
        threadId: "thread",
        actionId: "delete",
        reviewDigest: review["reviewDigest"],
        decision: "approve",
      },
      signal,
    )) as Record<string, unknown>;
    assert.equal(approved["status"], "completed");
    assert.equal(docs.size, 0);
    assert.equal(effects, 2);
    const completedReview = await service.browser(
      gm,
      { kind: "world", threadId: "thread", actionId: "delete" },
      signal,
    );
    await ui.validateWorldReview(completedReview, scope);
  } finally {
    db.close();
  }
});

void test("independent: matching embedded ID and hash from another parent are rejected", async () => {
  const db = new DatabaseSync(":memory:");
  const source = { _id: "shared", name: "Shield" };
  const client: FoundryLocalApiMcpClient = {
    listTools: () =>
      Promise.resolve(
        ["foundry_get_actor_item", "foundry_get_world_document"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      ),
    callTool: () =>
      Promise.resolve({
        worldId: "world",
        family: "actor-items",
        operation: "get",
        targetId: "shared",
        parentId: "anotherActor",
        source,
        revision: worldSourceRevision(source),
      }),
  };
  const service = new ChatKitWorldDocumentActions(client, db, () => Promise.resolve());
  try {
    await assert.rejects(
      service.request(
        { clientId: "fixture", worldId: "world", userId: "gm", isGm: true, lane: "gm" },
        { worldId: "world", userId: "gm", threadId: "thread" },
        "read",
        { toolId: "foundry_get_actor_item", args: { actorId: "selectedActor", itemId: "shared" } },
        undefined,
        new AbortController().signal,
      ),
      /scope|parent/i,
    );
  } finally {
    db.close();
  }
});
