export interface WorldReview {
  kind: "world" | "world-file";
  scope: { worldId: string; userId: string; threadId: string };
  actionId: string;
  request: Record<string, unknown>;
  before: Record<string, unknown>;
  reviewDigest: string;
  status: string;
  receipt: unknown;
  requiresConfirmation: boolean;
  reviewComplete: boolean;
}
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
};
export async function validateWorldReview(
  value: unknown,
  scope: WorldReview["scope"],
): Promise<WorldReview> {
  const review = value as WorldReview;
  if (
    !review ||
    !["world", "world-file"].includes(review.kind) ||
    review.reviewComplete !== true ||
    typeof review.requiresConfirmation !== "boolean" ||
    (review.status === "pending" && !review.requiresConfirmation) ||
    review.scope?.worldId !== scope.worldId ||
    review.scope.userId !== scope.userId ||
    review.scope.threadId !== scope.threadId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(review.actionId) ||
    !/^[a-f0-9]{64}$/.test(review.reviewDigest) ||
    !review.request ||
    !review.before ||
    new TextEncoder().encode(JSON.stringify(value)).length > 96_000
  )
    throw new Error("Complete world change review unavailable. Refresh before deciding.");
  const payload = {
    scope: review.scope,
    input: review.request,
    before: review.before,
    selectedTarget: review.kind === "world" ? review.before["targetId"] : review.request["path"],
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(payload))),
  );
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  if (actual !== review.reviewDigest)
    throw new Error("World change review changed. Approval disabled.");
  return review;
}
