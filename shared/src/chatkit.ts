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
}

export const AI_DM_CHATKIT_HEADERS = {
  session: "x-ai-dm-session",
  client: "x-ai-dm-client",
  version: "x-ai-dm-version",
  browserSession: "x-ai-dm-browser-session",
} as const;
