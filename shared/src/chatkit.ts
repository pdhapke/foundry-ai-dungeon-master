/** The only game fields sent by the GM-only ChatKit panel. All strings are untrusted data. */
export interface AiDmChatKitContext {
  sceneId?: string;
  sceneName?: string;
  controlledTokenIds?: string[];
  controlledActorIds?: string[];
  targetTokenIds?: string[];
  combatId?: string;
  round?: number;
  turn?: number;
}

export interface AiDmChatKitTrigger {
  prompt: string;
  context?: AiDmChatKitContext;
  requestId?: string;
  /** Authenticated GM observation hints; never filesystem/game execution authority. */
  automatic?: {
    kind: "area" | "door" | "turn";
    worldId: string;
    sceneId: string;
    documentId: string;
    revision: number;
    transition: string;
    tokenId?: string;
    regionId?: string;
    key?: string;
  };
}

export const AI_DM_CHATKIT_HEADERS = {
  session: "x-ai-dm-session",
  client: "x-ai-dm-client",
  version: "x-ai-dm-version",
  browserSession: "x-ai-dm-browser-session",
} as const;

/** Reviewed SDK operations. New SDK routes fail closed until their effects are reviewed. */
export const CHATKIT_INFERENCE_OPERATIONS: readonly string[] = [
  "threads.create",
  "threads.add_user_message",
  "threads.custom_action",
  "threads.retry_after_item",
];
export const CHATKIT_STORAGE_OPERATIONS: readonly string[] = [
  "threads.get_by_id",
  "threads.list",
  "items.list",
  "items.feedback",
  "threads.update",
  "threads.delete",
];
export function supportedChatKitOperation(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (CHATKIT_INFERENCE_OPERATIONS.includes(value) || CHATKIT_STORAGE_OPERATIONS.includes(value))
  );
}

/** A historical confirmed observation, not a claim about current world state. */
export interface AiDmMutationBoundaryAcknowledgement {
  version: 1;
  mutationCapability: "permanently-revoked";
  receiptDigest: string;
  stateRevision: string;
  stateRevisionKind: "receipt-state-digest";
  scope: "confirmed-receipt-observation; may be superseded";
}
