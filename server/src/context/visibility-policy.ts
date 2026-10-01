import type { AiDmAccessScope, AiDmVisibility } from "@foundry-ai-dungeon-master/shared";

import type { ContextAccessDecision, ContextNodeRecord, ContextViewRequest } from "./types.js";

function scopeAllows(scope: AiDmAccessScope, userId: string, isGm: boolean): boolean {
  if (isGm) return true;
  if (scope.kind === "public") return true;
  if (scope.kind === "gm") return false;
  return scope.userIds.includes(userId);
}

function scopeAllowsAudience(
  disclosure: AiDmAccessScope,
  audience: AiDmAccessScope,
  principalUserId: string,
  principalIsGm: boolean,
): boolean {
  if (audience.kind === "public") return disclosure.kind === "public";
  if (audience.kind === "gm") return disclosure.kind === "public" || disclosure.kind === "gm";
  if (disclosure.kind === "public") return true;
  if (disclosure.kind === "users") {
    return audience.userIds.every((userId) => disclosure.userIds.includes(userId));
  }
  return principalIsGm && audience.userIds.length === 1 && audience.userIds[0] === principalUserId;
}

export function contextAccessDecision(
  record: ContextNodeRecord,
  request: ContextViewRequest,
): ContextAccessDecision {
  const { node } = record;
  const principal = request.principal.runPrincipal;

  if (request.view === "resolver" && request.principal.resolverCanReadSecrets) {
    return { allowed: true, visibility: record.visibility, reason: "allowed" };
  }

  if (
    node.activation.status === "inactive" ||
    (node.activation.status === "conditional" &&
      (!node.activation.conditionRef ||
        !request.activeConditionRefs.has(node.activation.conditionRef)))
  ) {
    return { allowed: false, visibility: record.visibility, reason: "inactive" };
  }
  if (!scopeAllows(node.readScope, principal.userId, principal.isGm)) {
    return { allowed: false, visibility: record.visibility, reason: "read-scope" };
  }
  if (request.view === "presenter") {
    if (record.visibility === "secret" && !principal.isGm) {
      return { allowed: false, visibility: record.visibility, reason: "secret" };
    }
    if (!scopeAllows(node.disclosureScope, principal.userId, principal.isGm)) {
      return { allowed: false, visibility: record.visibility, reason: "disclosure-scope" };
    }
    if (
      request.principal.presenterAudienceScope &&
      !scopeAllowsAudience(
        node.disclosureScope,
        request.principal.presenterAudienceScope,
        principal.userId,
        principal.isGm,
      )
    ) {
      return { allowed: false, visibility: record.visibility, reason: "disclosure-scope" };
    }
  }
  return { allowed: true, visibility: record.visibility, reason: "allowed" };
}

const visibilityRank: Record<AiDmVisibility, number> = {
  public: 0,
  player: 1,
  gm: 2,
  secret: 3,
};

export function mostRestrictiveVisibility(values: readonly AiDmVisibility[]): AiDmVisibility {
  return values.reduce<AiDmVisibility>(
    (current, candidate) =>
      visibilityRank[candidate] > visibilityRank[current] ? candidate : current,
    "public",
  );
}

export function mostRestrictiveScope(scopes: readonly AiDmAccessScope[]): AiDmAccessScope {
  if (scopes.some((scope) => scope.kind === "gm")) return { kind: "gm" };
  const userScopes = scopes.filter(
    (scope): scope is Extract<AiDmAccessScope, { kind: "users" }> => scope.kind === "users",
  );
  if (userScopes.length === 0) return { kind: "public" };
  const intersection = userScopes
    .slice(1)
    .reduce(
      (allowed, scope) => allowed.filter((userId) => scope.userIds.includes(userId)),
      [...(userScopes[0]?.userIds ?? [])],
    );
  return intersection.length > 0 ? { kind: "users", userIds: intersection.sort() } : { kind: "gm" };
}
