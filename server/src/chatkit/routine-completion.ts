import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { explicitPauseRequest } from "./pause-request.js";

/** Exact sole-request semantics, transported only over authenticated loopback.
 * This is completion eligibility, never execution authority. Labels requiring
 * retrieval stay in the normal SDK loop. Python also checks schema, exact tool
 * arguments, complete confirmed receipt and durable protocol exchange.
 */
export interface RoutineCompletionContract {
  version: 1;
  toolName: string;
  arguments: Record<string, AiDmJsonValue>;
}
export function routineCompletion(body: unknown): RoutineCompletionContract | undefined {
  const pause = explicitPauseRequest(body);
  if (pause) return { version: 1, toolName: "foundry_set_pause_state", arguments: pause };
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const r = body as Record<string, unknown>;
  if (!["threads.create", "threads.add_user_message"].includes(String(r["type"]))) return;
  const content = (r["params"] as { input?: { content?: unknown } } | undefined)?.input?.content;
  if (!Array.isArray(content) || content.length !== 1) return;
  const part = content[0] as { type?: unknown; text?: unknown };
  if (part?.type !== "input_text" || typeof part.text !== "string" || part.text.length > 1000) return;
  const text = part.text.trim().replace(/^please\s+/i, "").replace(/[.!?]$/, "");
  const id = "([A-Za-z0-9_-]{1,128})";
  const exact = (pattern: string) => new RegExp(`^${pattern}$`, "i").exec(text);
  const contract = (toolName: string, args: RoutineCompletionContract["arguments"]): RoutineCompletionContract => ({ version: 1, toolName, arguments: args });
  let m: RegExpExecArray | null;
  // The entire request is one explicit door action plus receipt formatting.
  // Do not strip arbitrary suffixes: any extra work must retain the SDK loop.
  const input = (r["params"] as { input?: { attachments?: unknown; quoted_text?: unknown } }).input;
  const hasExtraContext = (input?.attachments !== undefined &&
    (!Array.isArray(input.attachments) || input.attachments.length > 0)) ||
    (input?.quoted_text !== undefined && input.quoted_text !== null && input.quoted_text !== "");
  if (!hasExtraContext && (m = exact(`(open|close|lock) door ${id} in scene ${id}\\. Change only that door\\. Return its confirmed receipt; do not add narration`)))
    return contract("foundry_set_door_state", { scene_id: m[3]!, door_id: m[2]!, state: { open: "open", close: "closed", lock: "locked" }[m[1]!.toLowerCase()]! });
  // Explicit scene-unit emission only: no names, inferred spell defaults,
  // vision/prototype settings, or additional requested work can complete early.
  const radius = "([0-9]{1,5}(?:\\.[0-9]{1,2})?)";
  const lightSuffix = "(?:\\. Change only those radii\\. Return its confirmed receipt; do not add narration)?";
  if (!hasExtraContext && (m = exact(`set token ${id} in scene ${id} emitted light to bright ${radius} and dim ${radius} scene units${lightSuffix}`)) && Number(m[3]) <= 10000 && Number(m[4]) <= 10000)
    return contract("foundry_set_token_light", { scene_id: m[2]!, token_id: m[1]!, light: { bright: Number(m[3]), dim: Number(m[4]) } });
  if (!hasExtraContext && (m = exact(`set token ${id} in scene ${id} emitted light to (bright|dim) ${radius} scene units`)) && Number(m[4]) <= 10000)
    return contract("foundry_set_token_light", { scene_id: m[2]!, token_id: m[1]!, light: { [m[3]!.toLowerCase()]: Number(m[4]) } });
  if (!hasExtraContext && (m = exact(`clear token ${id} emitted light in scene ${id}`)))
    return contract("foundry_set_token_light", { scene_id: m[2]!, token_id: m[1]!, light: { bright: 0, dim: 0 } });
  if ((m = exact(`(open|close|lock) door ${id} in scene ${id}`)))
    return contract("foundry_set_door_state", { scene_id: m[3]!, door_id: m[2]!, state: { open: "open", close: "closed", lock: "locked" }[m[1]!.toLowerCase()]! });
  if ((m = exact(`(move|teleport) token ${id} in scene ${id} to ([0-9]{1,6}),\\s*([0-9]{1,6})`)) && Number(m[4]) <= 100000 && Number(m[5]) <= 100000)
    return contract("foundry_move_token", { scene_id: m[3]!, token_id: m[2]!, x: Number(m[4]), y: Number(m[5]), mode: m[1]!.toLowerCase() === "teleport" ? "teleport" : "walk" });
  if ((m = exact(`set actor ${id} hp to ([0-9]{1,5}) in scene ${id}`)))
    return contract("foundry_set_actor_hp", { scene_id: m[3]!, actor_id: m[1]!, value: Number(m[2]) });
  if ((m = exact(`set actor ${id} condition ${id} (on|off) in scene ${id}`)))
    return contract("foundry_set_actor_condition", { scene_id: m[4]!, actor_id: m[1]!, condition_id: m[2]!, active: m[3]!.toLowerCase() === "on" });
  if ((m = exact(`advance combat ${id} in scene ${id} turn`)))
    return contract("foundry_advance_combat_turn", { scene_id: m[2]!, combat_id: m[1]! });
  if ((m = exact(`set combatant ${id} initiative to (-?[0-9]{1,4}) in combat ${id} in scene ${id}`)))
    return contract("foundry_set_initiative", { scene_id: m[4]!, combat_id: m[3]!, combatant_id: m[1]!, value: Number(m[2]) });
  if ((m = exact("roll ((?:[1-9]|[1-9][0-9])d(?:4|6|8|10|12|20|100)(?:[+-][0-9]{1,3})?)")))
    return contract("foundry_roll_dice", { formula: m[1]!.toLowerCase() });
  if ((m = exact(`roll actor ${id} (ability|save|skill) ${id} in scene ${id}`)))
    return contract("foundry_roll_actor", { scene_id: m[4]!, actor_id: m[1]!, roll_type: m[2]!.toLowerCase(), key: m[3]! });
  return;
}
