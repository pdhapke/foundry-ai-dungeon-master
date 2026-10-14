/** Diagnostic shortcut uses explicit IDs and the same backend as natural-language tools. */
export function normalizeChatCommand(message: string): string {
  const text = message.trim();
  if (!text.startsWith("<")) return text;
  // Foundry v14 passes the chat editor's serialized paragraph before command parsing.
  // Accept only its plain paragraph/br envelope, never executable or rich HTML.
  const paragraph = /^<p>([\s\S]*)<\/p>$/i.exec(text);
  if (!paragraph) return text;
  const body = paragraph[1]!.replace(/<br\s*\/?\s*>/gi, "\n");
  if (/[<>]/.test(body)) return text;
  return body.replace(/&(nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, key: string) => {
    const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (key.startsWith("#")) {
      const value = key[1]?.toLowerCase() === "x" ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
    }
    return named[key.toLowerCase()] ?? entity;
  }).trim();
}
export function parseCoreCommand(text: string): Record<string, unknown> {
  const [kind, ...args] = text.trim().split(/\s+/);
  const id = (n: number) => { const value = args[n]; if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Use explicit document IDs."); return value; };
  const number = (n: number) => { const value = Number(args[n]); if (!args[n] || !Number.isFinite(value)) throw new Error("Use numeric values."); return value; };
  const count = (n: number) => { if (args.length !== n) throw new Error("Wrong number of control arguments."); };
  switch (kind?.toLowerCase()) {
    case "teleport": count(4); return { kind: "token.position", sceneId: id(0), targetId: id(1), x: number(2), y: number(3), mode: "teleport" };
    case "move": count(4); return { kind: "token.position", sceneId: id(0), targetId: id(1), x: number(2), y: number(3) };
    case "door": { count(3); const value = { closed: 0, open: 1, locked: 2 }[args[2] as "closed" | "open" | "locked"]; if (value === undefined) throw new Error("Door state must be closed, open or locked."); return { kind: "door.state", sceneId: id(0), targetId: id(1), value }; }
    case "hp": count(3); return { kind: "actor.hp", sceneId: id(0), targetId: id(1), value: number(2) };
    case "condition": count(4); if (!["on", "off"].includes(args[3]!)) throw new Error("Condition state must be on or off."); return { kind: "actor.condition", sceneId: id(0), targetId: id(1), conditionId: id(2), active: args[3] === "on" };
    case "next": count(2); return { kind: "combat.next", sceneId: id(0), targetId: id(1) };
    case "initiative": count(4); return { kind: "combat.initiative", sceneId: id(0), targetId: id(1), combatantId: id(2), value: number(3) };
    case "attack": {
      if (args.length !== 6 && args.length !== 7) throw new Error("Attack needs scene, attacker token, actor, item, activity, target token IDs, and optional advantage/disadvantage.");
      const advantage = args[6] ?? "normal";
      if (!["normal", "advantage", "disadvantage"].includes(advantage)) throw new Error("Attack advantage must be normal, advantage or disadvantage.");
      return { mode: "roll", sceneId: id(0), attackerTokenId: id(1), actorId: id(2), itemId: id(3), activityId: id(4), targetTokenId: id(5), advantage };
    }
    case "attack-apply": count(1); return { mode: "apply", priorAttackRequestId: id(0) };
    case "roll": count(1); return { kind: "dice.roll", formula: args[0] };
    case "actor-roll": count(4); if (!["ability", "save", "skill"].includes(args[2]!)) throw new Error("Roll type must be ability, save or skill."); return { kind: "system.roll", sceneId: id(0), targetId: id(1), rollType: args[2], key: id(3) };
    default: throw new Error("Use /ai-control move, teleport, door, hp, condition, next, initiative, roll, actor-roll, attack or attack-apply with explicit IDs.");
  }
}
