import { routineCompletion, type RoutineCompletionContract } from "./routine-completion.js";
import { stableJson } from "../context/hash.js";
import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";

/** Only one completely specified mechanical request followed by this exact
 * narration clause. Compound/retrieval/choices retain their full mutation slot.
 */
export function narrationCompletion(body: unknown): RoutineCompletionContract | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const request = body as { type?: unknown; params?: { input?: { content?: unknown } } };
  const content = request.params?.input?.content;
  if (!Array.isArray(content) || content.length !== 1) return;
  const part = content[0] as { type?: unknown; text?: unknown };
  if (part?.type !== "input_text" || typeof part.text !== "string") return;
  const match = /^(.+?) (?:and|then) narrate the result[.!]?$/i.exec(part.text.trim());
  if (!match) return;
  return routineCompletion({ ...request, params: { ...request.params, input: { ...request.params?.input, content: [{ ...part, text: match[1] }] } } });
}

export function expectedNarrationAction(contract: RoutineCompletionContract): AiDmJsonValue | undefined {
  const a = contract.arguments, base = { sceneId: a["scene_id"]! };
  switch (contract.toolName) {
    case "foundry_set_token_light": return { kind: "token.light", ...base, targetId: a["token_id"]!, light: a["light"]! };
    case "foundry_move_token": return { kind: "token.position", ...base, targetId: a["token_id"]!, x: a["x"]!, y: a["y"]!, mode: a["mode"]! };
    case "foundry_set_door_state": return { kind: "door.state", ...base, targetId: a["door_id"]!, value: { closed: 0, open: 1, locked: 2 }[String(a["state"]) as "closed" | "open" | "locked"] };
    case "foundry_set_actor_hp": return { kind: "actor.hp", ...base, targetId: a["actor_id"]!, value: a["value"]! };
    case "foundry_set_actor_condition": return { kind: "actor.condition", ...base, targetId: a["actor_id"]!, conditionId: a["condition_id"]!, active: a["active"]! };
    case "foundry_advance_combat_turn": return { kind: "combat.next", ...base, targetId: a["combat_id"]! };
    case "foundry_set_initiative": return { kind: "combat.initiative", ...base, targetId: a["combat_id"]!, combatantId: a["combatant_id"]!, value: a["value"]! };
    case "foundry_roll_dice": return { kind: "dice.roll", formula: a["formula"]! };
    case "foundry_roll_actor": return { kind: "system.roll", ...base, targetId: a["actor_id"]!, rollType: a["roll_type"]!, key: a["key"]! };
    default: return;
  }
}
export function narrationReceiptMatches(contract: RoutineCompletionContract, operation: string, result: AiDmJsonValue): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result) || result["outcome"] !== "confirmed" || typeof result["mutated"] !== "boolean" || typeof result["correlationId"] !== "string" || !result["correlationId"]) return false;
  if (contract.toolName === "foundry_set_pause_state")
    return operation === "native_set_pause_core" && result["paused"] === contract.arguments["paused"];
  const expected = expectedNarrationAction(contract);
  if (operation !== "native_core_action" || result["schemaVersion"] !== "core-actions-v1" || expected === undefined ||
    stableJson(result["action"]) !== stableJson(expected) || !result["state"] || typeof result["state"] !== "object" || Array.isArray(result["state"])) return false;
  const state = result["state"], a = contract.arguments;
  const finite = (value: AiDmJsonValue | undefined): value is number => typeof value === "number" && Number.isFinite(value);
  const roll = (value: AiDmJsonValue) => Boolean(value && typeof value === "object" && !Array.isArray(value) && finite(value["total"]) && typeof value["formula"] === "string" && value["formula"].length > 0);
  switch (contract.toolName) {
    case "foundry_set_token_light": {
      const patch = a["light"], light = state["light"];
      return Boolean(patch && typeof patch === "object" && !Array.isArray(patch) &&
        light && typeof light === "object" && !Array.isArray(light) &&
        Object.keys(patch).length > 0 && Object.entries(patch).every(([key, value]) => light[key] === value));
    }
    case "foundry_move_token": return finite(state["x"]) && finite(state["y"]) && state["x"] === a["x"] && state["y"] === a["y"];
    case "foundry_set_door_state": return state["ds"] === (expected as Record<string, AiDmJsonValue>)["value"];
    case "foundry_set_actor_hp": return finite(state["value"]) && state["value"] === a["value"];
    case "foundry_set_actor_condition": return typeof state["active"] === "boolean" && state["active"] === a["active"];
    case "foundry_set_initiative": return finite(state["initiative"]) && state["initiative"] === a["value"];
    case "foundry_advance_combat_turn": return result["mutated"] === true && Number.isInteger(state["round"]) && Number(state["round"]) >= 1 && Number.isInteger(state["turn"]) && Number(state["turn"]) >= 0 && Number.isInteger(state["turnCount"]) && Number(state["turnCount"]) > Number(state["turn"]);
    case "foundry_roll_dice": return result["mutated"] === true && roll(state) && String(state["formula"]).replace(/\s/g, "").toLowerCase() === a["formula"];
    case "foundry_roll_actor": return result["mutated"] === true && state["systemId"] === "dnd5e" && state["rollType"] === a["roll_type"] && state["key"] === a["key"] && Array.isArray(state["rolls"]) && state["rolls"].length > 0 && state["rolls"].every(roll);
    default: return false;
  }
}
