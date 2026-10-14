export interface CampaignReviewFile {
  path: string;
  expectedRevision: string | null;
  beforeHash: string | null;
  afterHash: string;
  beforeText: string | null;
  proposedText: string;
  beforeCanonStatus: string | null;
  afterCanonStatus: string;
}
export interface CampaignReview {
  kind: "campaign";
  schemaVersion: 1;
  proposalId: string;
  title: string;
  worldId: string;
  userId: string;
  threadId: string;
  batchDigest: string;
  status: string;
  expiresAt: number;
  files: CampaignReviewFile[];
  receipt: unknown;
  issue: string | null;
  reviewAvailable: true;
  requiresConfirmation: true;
}
const hashPattern = /^[a-f0-9]{64}$/;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Exact review is complete, hash-bound data; nothing here executes authored Markdown. */
export async function validateCampaignReview(
  value: unknown,
  scope: { worldId: string; userId: string; threadId: string },
): Promise<CampaignReview> {
  const review = value as CampaignReview & { truncated?: unknown; scope?: unknown };
  if (
    !review ||
    review.kind !== "campaign" ||
    review.schemaVersion !== 1 ||
    review.reviewAvailable !== true ||
    review.requiresConfirmation !== true ||
    review.truncated === true ||
    review.worldId !== scope.worldId ||
    review.userId !== scope.userId ||
    review.threadId !== scope.threadId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(review.proposalId) ||
    typeof review.title !== "string" ||
    review.title.length > 120 ||
    !hashPattern.test(review.batchDigest) ||
    !Array.isArray(review.files) ||
    !review.files.length ||
    review.files.length > 32 ||
    typeof review.status !== "string" ||
    !Number.isFinite(review.expiresAt) ||
    new TextEncoder().encode(JSON.stringify(value)).length > 24_000
  )
    throw new Error("Complete exact campaign review is unavailable. Refresh before deciding.");
  const files: CampaignReviewFile[] = [];
  const paths = new Set<string>();
  for (const file of review.files) {
    if (
      !file ||
      (file as CampaignReviewFile & { truncated?: unknown }).truncated === true ||
      typeof file.path !== "string" ||
      !/^(overview\.md|index\.md|(?:locations|npcs|factions|quests|rules|sessions)\/[A-Za-z0-9_-][A-Za-z0-9_. -]*\.md)$/.test(
        file.path,
      ) ||
      paths.has(file.path.toLowerCase()) ||
      typeof file.proposedText !== "string" ||
      !(file.beforeText === null || typeof file.beforeText === "string") ||
      !(
        file.expectedRevision === null ||
        (typeof file.expectedRevision === "string" && hashPattern.test(file.expectedRevision))
      ) ||
      file.beforeHash !== file.expectedRevision ||
      !hashPattern.test(file.afterHash) ||
      file.afterCanonStatus !== "canon" ||
      !(file.beforeCanonStatus === null || ["canon", "draft"].includes(file.beforeCanonStatus)) ||
      (file.beforeText === null) !== (file.beforeHash === null) ||
      (await sha256(file.proposedText)) !== file.afterHash ||
      (file.beforeText !== null && (await sha256(file.beforeText)) !== file.beforeHash)
    )
      throw new Error("Campaign file review is incomplete or changed; approval disabled.");
    paths.add(file.path.toLowerCase());
    files.push({
      path: file.path,
      expectedRevision: file.expectedRevision,
      proposedText: file.proposedText,
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
      beforeText: file.beforeText,
      beforeCanonStatus: file.beforeCanonStatus,
      afterCanonStatus: file.afterCanonStatus,
    });
  }
  if (!paths.has("overview.md") || !paths.has("index.md"))
    throw new Error("Campaign overview/index review missing; approval disabled.");
  if (
    (await sha256(
      JSON.stringify(canonical({ schemaVersion: 1, scope, title: review.title, files })),
    )) !== review.batchDigest
  )
    throw new Error("Campaign review digest mismatch; approval disabled.");
  return review;
}
export function campaignReceiptText(review: CampaignReview): string {
  const receipt = review.receipt as {
    outcome?: unknown;
    proposalId?: unknown;
    batchDigest?: unknown;
    worldId?: unknown;
    receiptId?: unknown;
    files?: Array<{ path?: unknown; revision?: unknown; sourceHash?: unknown }>;
  } | null;
  if (
    review.status === "completed" &&
    receipt?.outcome === "completed" &&
    receipt.proposalId === review.proposalId &&
    receipt.batchDigest === review.batchDigest &&
    receipt.worldId === review.worldId &&
    typeof receipt.receiptId === "string" &&
    receipt.files?.length === review.files.length &&
    review.files.every((file) =>
      receipt.files!.some(
        (actual) =>
          actual.path === file.path &&
          actual.revision === file.afterHash &&
          actual.sourceHash === file.afterHash,
      ),
    )
  )
    return `Verified campaign commit: ${receipt.receiptId}.`;
  if (review.status === "completed")
    return "Completion receipt unavailable; refresh before relying on this change.";
  if (["dispatching", "uncertain", "drafting"].includes(review.status))
    return "Outcome requires inspection. Refresh the exact review; do not blindly repeat the change.";
  if (review.status === "pending")
    return "Draft saved; these exact changes have not been approved as canon.";
  return `Campaign proposal ${review.status}.`;
}
