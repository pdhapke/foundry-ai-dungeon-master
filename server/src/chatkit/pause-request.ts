/** Strict direct human request only. Retrieval, quotations and automatic custom actions cannot authorize pause writes. */
function directText(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as Record<string, unknown>;
  if (!["threads.create", "threads.add_user_message"].includes(String(request["type"])))
    return undefined;
  const params = request["params"] as Record<string, unknown> | undefined;
  const input = params?.["input"] as Record<string, unknown> | undefined;
  const content = input?.["content"];
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const part = content[0] as Record<string, unknown> | undefined;
  if (part?.["type"] !== "input_text" || typeof part["text"] !== "string") return undefined;
  return part["text"].trim();
}
export function explicitPauseRequest(body: unknown): { paused: boolean } | undefined {
  const text = directText(body)
    ?.replace(/^here we go,\s*/i, "")
    .replace(/^(?:can|could|would) you\s+/i, "")
    .replace(/\s+please[.!?]?$/i, "")
    .replace(/[?]$/, "");
  if (!text) return undefined;
  if (/^(?:please\s+)?(?:unpause|resume)(?:\s+(?:the\s+)?game)?[.!]?$/i.test(text))
    return { paused: false };
  if (/^(?:please\s+)?pause(?:\s+(?:the\s+)?game)?[.!]?$/i.test(text)) return { paused: true };
  return undefined;
}
export interface SessionRequestAuthorization {
  attackDecision?: { priorAttackRequestId: string; decisionId: string };
  worldControl?: { manualRequest: true; requestDigest: string };
  paused?: boolean;
  sessionKinds?: string[];
  session?: {
    kind: string;
    targetLabel?: string;
    value?: number;
    x?: number;
    y?: number;
    text?: string;
    conditionId?: string;
    active?: boolean;
    state?: string;
    soundLabel?: string;
  };
}
export type ExplicitSessionRequest = SessionRequestAuthorization;
/** One narrowly recognized current human operation, not inferred campaign text or historical intent. */
export function explicitSessionRequest(body: unknown): ExplicitSessionRequest | undefined {
  const pause = explicitPauseRequest(body);
  if (pause) return pause;
  const text = directText(body);
  if (
    !text ||
    text.length > 1000 ||
    /["`\r\n]|\b(?:not|don't|never|ignore|instead|instructions|campaign says)\b/i.test(text)
  )
    return undefined;
  const request = text
    .replace(/^here we go,\s*/i, "")
    .replace(/^(?:can|could|would) you\s+/i, "")
    .replace(/^please\s+/i, "")
    .replace(/\s+please[.!?]?$/i, "")
    .replace(/[.!?]$/, "");
  let session: NonNullable<SessionRequestAuthorization["session"]> | undefined;
  let match: RegExpExecArray | null;
  if (
    (match = /^set (?:the )?([A-Za-z0-9 _'-]{1,80}?) (?:hp|hit points) to ([0-9]{1,5})$/i.exec(
      request,
    ))
  )
    session = {
      kind: "actor.hp",
      targetLabel: match[1]!.replace(/'s$/, ""),
      value: Number(match[2]),
    };
  else if (
    (match = /^(open|close|lock) (?:the )?([A-Za-z0-9 _'-]{1,80})$/i.exec(request)) &&
    /\bdoor\b/i.test(match[2]!)
  )
    session = {
      kind: "door.state",
      targetLabel: match[2]!.replace(/^door\s+/i, "").replace(/\s+door$/i, ""),
      value: match[1]!.toLowerCase() === "open" ? 1 : match[1]!.toLowerCase() === "close" ? 0 : 2,
    };
  else if (
    (match =
      /^move (?:the )?([A-Za-z0-9 _'-]{1,80}?) to (?:x ?=? ?)?([0-9]{1,6})[, ]+(?:y ?=? ?)?([0-9]{1,6})$/i.exec(
        request,
      ))
  )
    session = {
      kind: "token.position",
      targetLabel: match[1]!.replace(/ token$/i, ""),
      x: Number(match[2]),
      y: Number(match[3]),
    };
  else if (
    /^(?:advance (?:the )?(?:combat )?turn|next (?:combat )?turn|end (?:the )?(?:current )?turn)$/i.test(
      request,
    )
  )
    session = { kind: "combat.next" };
  else if (
    (match = /^set (?:the )?([A-Za-z0-9 _'-]{1,80}?) initiative to (-?[0-9]{1,4})$/i.exec(request))
  )
    session = {
      kind: "combat.initiative",
      targetLabel: match[1]!.replace(/'s$/, ""),
      value: Number(match[2]),
    };
  else if (
    (match = /^post (?:this )?(?:message )?to (?:the )?chat: ([^\r\n]{1,800})$/i.exec(
      text.replace(/^please\s+/i, ""),
    ))
  )
    session = { kind: "chat.post", text: match[1]! };
  else if (
    (match =
      /^set (?:the )?([A-Za-z0-9 _'-]{1,80}?) condition ([A-Za-z0-9_-]{1,80}) (on|off)$/i.exec(
        request,
      ))
  )
    session = {
      kind: "actor.condition",
      targetLabel: match[1]!,
      conditionId: match[2]!,
      active: match[3]!.toLowerCase() === "on",
    };
  else if ((match = /^(play|pause|stop) (?:the )?music ([A-Za-z0-9 _'-]{1,80})$/i.exec(request)))
    session = {
      kind: "playlist.sound",
      soundLabel: match[2]!,
      state:
        match[1]!.toLowerCase() === "play"
          ? "playing"
          : match[1]!.toLowerCase() === "pause"
            ? "paused"
            : "stopped",
    };
  return session ? { sessionKinds: [session.kind], session } : undefined;
}
