import { createHash } from "node:crypto";

import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";

import type { AiDmAuthoritativeProjection, AiDmWorldGateway } from "../orchestration/index.js";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";

type JsonObject = Record<string, AiDmJsonValue>;

function object(value: AiDmJsonValue, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Foundry returned an invalid ${label}.`);
  }
  return value;
}

function array(value: AiDmJsonValue, label: string): AiDmJsonValue[] {
  if (!Array.isArray(value)) throw new Error(`Foundry returned an invalid ${label}.`);
  return value;
}

function id(value: JsonObject): string | null {
  const candidate = value["id"] ?? value["_id"];
  return typeof candidate === "string" ? candidate : null;
}

function bool(value: AiDmJsonValue | undefined): boolean {
  return value === true;
}

function integer(value: AiDmJsonValue | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function revision(value: AiDmJsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export class FoundryWorldGateway implements AiDmWorldGateway {
  constructor(private readonly client: FoundryLocalApiMcpClient) {}

  async project(input: {
    event: import("@foundry-ai-dungeon-master/shared").AiDmNormalizedEvent;
    identity: AiDmAuthenticatedIdentity;
  }): Promise<AiDmAuthoritativeProjection> {
    const [worldValue, usersValue, userValue] = await Promise.all([
      this.#call("foundry_get_world", {}),
      this.#call("foundry_list_users", {}),
      this.#call("foundry_get_user_by_id", { userId: input.identity.userId }),
    ]);
    const world = object(worldValue, "world");
    if (id(world) !== input.identity.worldId) throw new Error("Active Foundry world changed.");
    const user = object(userValue, "user");
    const role = integer(user["role"]) ?? 0;
    const isGm = bool(user["isGM"]) || role >= 4;
    if (isGm !== input.identity.isGm) throw new Error("Foundry permission role changed.");

    const users = array(usersValue, "user list").map((value) => object(value, "user"));
    const activeUserIds = users
      .filter((item) => bool(item["active"]))
      .flatMap((item) => {
        const value = id(item);
        return value ? [value] : [];
      });
    const gmUserIds = users
      .filter((item) => bool(item["isGM"]) || (integer(item["role"]) ?? 0) >= 4)
      .flatMap((item) => {
        const value = id(item);
        return value ? [value] : [];
      });

    const sceneId = input.event.contextHints.sceneId ?? null;
    const sceneValue = sceneId ? await this.#call("foundry_get_scene", { id: sceneId }) : null;
    const scene = sceneValue === null ? null : object(sceneValue, "scene");
    if (!isGm && scene && !bool(scene["active"])) {
      throw new Error("The hinted Scene is not the active player-visible Scene.");
    }
    const sceneTokens = scene && Array.isArray(scene["tokens"]) ? scene["tokens"] : [];
    const tokens = new Map(
      sceneTokens.map((value) => {
        const token = object(value, "token");
        return [id(token), token] as const;
      }),
    );
    const hintedControlledTokenIds = (input.event.contextHints.controlledTokenIds ?? []).filter(
      (value) => tokens.has(value),
    );
    const targetTokenIds = (input.event.contextHints.targetTokenIds ?? []).filter((value) =>
      tokens.has(value),
    );
    const actorIdsFromTokens = hintedControlledTokenIds.flatMap((tokenId) => {
      const actorId = tokens.get(tokenId)?.["actorId"];
      return typeof actorId === "string" ? [actorId] : [];
    });
    const ownedActorIds = new Set<string>();
    if (isGm) {
      for (const actorId of actorIdsFromTokens) ownedActorIds.add(actorId);
    } else {
      await Promise.all(
        [...new Set(actorIdsFromTokens)].map(async (actorId) => {
          const actor = object(await this.#call("foundry_get_actor", { id: actorId }), "actor");
          const ownership =
            typeof actor["ownership"] === "object" &&
            actor["ownership"] !== null &&
            !Array.isArray(actor["ownership"])
              ? actor["ownership"]
              : {};
          const userLevel = integer(ownership[input.identity.userId]);
          const defaultLevel = integer(ownership["default"]);
          if ((userLevel ?? defaultLevel ?? 0) >= 3) ownedActorIds.add(actorId);
        }),
      );
    }
    const controlledTokenIds = hintedControlledTokenIds.filter((tokenId) => {
      const actorId = tokens.get(tokenId)?.["actorId"];
      return typeof actorId === "string" && ownedActorIds.has(actorId);
    });
    const controlledActorIds = [
      ...new Set(
        (input.event.contextHints.controlledActorIds ?? []).filter((actorId) =>
          ownedActorIds.has(actorId),
        ),
      ),
    ];

    const combatsValue = await this.#call("foundry_list_combats", {});
    const combats = array(combatsValue, "combat list").map((value) => object(value, "combat"));
    const combat =
      combats.find((item) => {
        const combatScene = item["scene"] ?? item["sceneId"];
        return bool(item["active"]) && (sceneId === null || combatScene === sceneId);
      }) ?? null;
    const combatants = combat && Array.isArray(combat["combatants"]) ? combat["combatants"] : [];
    const turn = combat ? integer(combat["turn"]) : null;
    const activeCombatant =
      turn !== null && turn >= 0 && turn < combatants.length
        ? object(combatants[turn]!, "combatant")
        : null;
    const capturedAt = new Date().toISOString();
    const sourceRevisions = {
      world: revision(worldValue),
      users: revision(usersValue),
      ...(sceneValue === null ? {} : { scene: revision(sceneValue) }),
      combats: revision(combatsValue),
    };
    const projectionBody = {
      eventId: input.event.eventId,
      capturedAt,
      worldId: input.identity.worldId,
      userId: input.identity.userId,
      role,
      sceneId,
      controlledTokenIds,
      controlledActorIds,
      targetTokenIds,
      combatId: combat ? id(combat) : null,
      sourceRevisions,
    };
    return {
      principal: {
        ...input.identity,
        connectionId: `connection:${input.identity.clientId}`,
        role,
        authorizedAudienceKinds: isGm
          ? ["private", "gm", "selected-users", "table"]
          : ["private", "gm"],
        permissionSnapshotRevision: revision({ user: userValue, world: worldValue }),
      },
      projection: {
        projectionId: `projection-${revision(projectionBody).slice(0, 32)}`,
        eventId: input.event.eventId,
        revision: revision(projectionBody),
        capturedAt,
        worldId: input.identity.worldId,
        authoritativeUserId: input.identity.userId,
        permissionRole: role,
        activeSceneId: sceneId,
        controlledTokenIds,
        controlledActorIds,
        targetTokenIds,
        activeCombatId: combat ? id(combat) : null,
        activeCombatantId: activeCombatant ? id(activeCombatant) : null,
        activeCombatantTokenId:
          activeCombatant && typeof activeCombatant["tokenId"] === "string"
            ? activeCombatant["tokenId"]
            : null,
        activeCombatantActorId:
          activeCombatant && typeof activeCombatant["actorId"] === "string"
            ? activeCombatant["actorId"]
            : null,
        combatRound: combat ? integer(combat["round"]) : null,
        combatTurn: turn,
        campaignStateRevision: null,
        sourceRevisions,
        selectedDocumentUuids:
          isGm &&
          (input.event.requestedAudience.kind === "private" ||
            input.event.requestedAudience.kind === "gm")
            ? (input.event.contextHints.selectedDocumentUuids ?? [])
            : [],
      },
      activeUserIds,
      gmUserIds,
    };
  }

  async mirrorPublicNarration(input: { text: string; eventId: string }): Promise<void> {
    const createdValue = await this.#call("foundry_send_chat_message", {
      data: {
        content: escapeHtml(input.text),
        flags: { "foundry-ai-dungeon-master": { causeEventId: input.eventId } },
      },
    });
    const created = object(createdValue, "created chat message");
    const createdId = id(created);
    if (!createdId) throw new Error("Foundry did not return the created chat message ID.");
    const readBack = object(
      await this.#call("foundry_get_chat_message", { id: createdId }),
      "chat message read-back",
    );
    if (id(readBack) !== createdId) throw new Error("Foundry chat read-back did not match.");
  }

  #call(name: string, argumentsValue: AiDmJsonValue): Promise<AiDmJsonValue> {
    return this.client.callTool({ name, arguments: argumentsValue, idempotencyKey: null });
  }
}
