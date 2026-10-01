import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AiDmJsonValue, AiDmNormalizedEvent } from "@foundry-ai-dungeon-master/shared";

import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { FoundryWorldGateway } from "./foundry-world-gateway.js";

void describe("Foundry authoritative world gateway", () => {
  void it("cross-checks hinted token ownership and sanitizes public chat with read-back", async () => {
    const calls: Array<{ name: string; arguments: AiDmJsonValue }> = [];
    const client: FoundryLocalApiMcpClient = {
      listTools: () => Promise.resolve([]),
      callTool: ({ name, arguments: args }) => {
        calls.push({ name, arguments: args });
        const values: Record<string, AiDmJsonValue> = {
          foundry_get_world: { _id: "world-1" },
          foundry_get_user_by_id: {
            _id: "user-1",
            name: "Player",
            role: 1,
            isGM: false,
          },
          foundry_list_users: [
            { _id: "user-1", role: 1, isGM: false, active: true },
            { _id: "gm-1", role: 4, isGM: true, active: true },
          ],
          foundry_get_scene: {
            _id: "scene-1",
            active: true,
            tokens: [
              { _id: "token-owned", actorId: "actor-owned" },
              { _id: "token-other", actorId: "actor-other" },
            ],
          },
          foundry_get_actor:
            typeof args === "object" &&
            args !== null &&
            !Array.isArray(args) &&
            args["id"] === "actor-owned"
              ? { _id: "actor-owned", ownership: { "user-1": 3 } }
              : { _id: "actor-other", ownership: { "user-1": 0 } },
          foundry_list_combats: [],
          foundry_send_chat_message: { _id: "chat-1" },
          foundry_get_chat_message: { _id: "chat-1" },
        };
        return Promise.resolve(values[name] ?? null);
      },
    };
    const gateway = new FoundryWorldGateway(client);
    const event: AiDmNormalizedEvent = {
      schemaVersion: 1,
      eventId: "event-1",
      sequence: 1,
      eventType: "player.prompt.submitted",
      source: "direct-prompt",
      occurredAt: "2026-09-29T00:00:00.000Z",
      receivedAt: "2026-09-29T00:00:00.000Z",
      authenticatedIdentity: {
        clientId: "client-1",
        userId: "user-1",
        worldId: "world-1",
        lane: "player",
        isGm: false,
      },
      presentation: "normal",
      requestedAudience: { kind: "private" },
      contextHints: {
        sceneId: "scene-1",
        controlledTokenIds: ["token-owned", "token-other", "token-forged"],
        controlledActorIds: ["actor-owned", "actor-other"],
        selectedDocumentUuids: ["JournalEntry.secret-entry"],
      },
      payload: { text: "look" },
      payloadHash: "hash",
      sourceCorrelationId: "request-1",
      deduplicationKey: "prompt:user-1:request-1",
      sourceStateRevision: null,
    };
    const projected = await gateway.project({ event, identity: event.authenticatedIdentity });
    assert.deepEqual(projected.projection.controlledTokenIds, ["token-owned"]);
    assert.deepEqual(projected.projection.controlledActorIds, ["actor-owned"]);
    assert.deepEqual(projected.projection.selectedDocumentUuids, []);

    await gateway.mirrorPublicNarration({ text: "<script>alert(1)</script>", eventId: "event-1" });
    const send = calls.find(({ name }) => name === "foundry_send_chat_message");
    assert.ok(send);
    assert.equal(JSON.stringify(send.arguments).includes("<script>"), false);
    assert.equal(
      calls.some(({ name }) => name === "foundry_get_chat_message"),
      true,
    );
  });
});
