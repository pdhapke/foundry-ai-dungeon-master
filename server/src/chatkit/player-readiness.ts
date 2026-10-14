import type { PlayerPerceptionReadiness } from "@foundry-ai-dungeon-master/shared";

/** Preparation/UI seam: only a validated adapter observation can be ready. */
export function playerReadiness(value: unknown): PlayerPerceptionReadiness {
  const report = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const seen = report["observation"] && typeof report["observation"] === "object"
    ? report["observation"] as Record<string, unknown> : {};
  const issues = Array.isArray(report["issues"]) ? report["issues"] : [];
  const disconnected = issues.some(issue => issue && typeof issue === "object" &&
    ["NOT_CONNECTED", "PLAYER_CLIENT_UNAVAILABLE"].includes(String((issue as Record<string, unknown>)["code"])));
  if (disconnected) return { status: "NOT_CONNECTED", retryable: true, binding: null };
  if (report["status"] === "stale") return { status: "stale", retryable: true, binding: null };
  if (report["status"] === "unsupported") return { status: "unsupported", retryable: false, binding: null };
  const fields = ["worldId", "sceneId", "userId", "clientId", "tokenId", "stateRevision", "id"];
  if (report["status"] !== "complete" || issues.length || seen["isGM"] !== false ||
    seen["optedIn"] !== true || seen["readiness"] !== "ready" || seen["pendingRenderFlags"] !== 0 ||
    !fields.every(key => typeof seen[key] === "string" && seen[key] !== ""))
    return { status: "incomplete", retryable: true, binding: null };
  return { status: "ready", binding: {
    worldId: String(seen["worldId"]), sceneId: String(seen["sceneId"]), userId: String(seen["userId"]),
    clientId: String(seen["clientId"]), tokenId: String(seen["tokenId"]), stateRevision: String(seen["stateRevision"]),
    observationId: String(seen["id"]),
  } };
}
