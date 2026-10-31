/** Operator configuration for the external AI-GM wake webhook. Secrets stay in the environment. */

export interface WakeWebhookConfig {
  /** True only when a usable URL is configured and every related value parsed. */
  enabled: boolean;
  url: string | null;
  /** Null omits the credential header. Never logged. */
  secret: string | null;
  /** HTTP header that carries the secret. Default `Authorization`. */
  headerName: string;
  /**
   * Prefix before the secret. Default `Bearer`, producing `Bearer <secret>`.
   * An empty string sends the secret as the entire header value.
   */
  scheme: string;
  /**
   * Quiet period: hold the wake until no new qualifying movement or chat event
   * has arrived for this long, then post one webhook for the whole burst. Default 5000.
   */
  debounceMs: number;
  /** Longest a burst may be held after its first event, even while events keep arriving. Default 15000. */
  maxWaitMs: number;
  /** When true, GM-authored moves and GM chat are not posted. Default true. */
  playersOnly: boolean;
  /** When true, movement is posted only if it crosses a room Region. Default false. */
  roomCrossingsOnly: boolean;
  /** Also post new player chat messages observed by the GM client. Default true. */
  chat: boolean;
  /** Also post combat turn changes. Default false. */
  combatTurns: boolean;
  /** Set when a provided value is invalid. The wake stays off and the queue reports this. */
  problem?: string;
}

const DEFAULT_LIMIT = 2_048;
const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 15_000;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "keep-alive",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function loadWakeWebhookConfig(environment: NodeJS.ProcessEnv): WakeWebhookConfig {
  const disabled: WakeWebhookConfig = {
    enabled: false,
    url: null,
    secret: null,
    headerName: "Authorization",
    scheme: "Bearer",
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxWaitMs: DEFAULT_MAX_WAIT_MS,
    playersOnly: true,
    roomCrossingsOnly: false,
    chat: true,
    combatTurns: false,
  };
  const rawUrl = environment["AI_DM_WAKE_WEBHOOK_URL"]?.trim() ?? "";
  if (!rawUrl) return disabled;

  const url = parseUrl(rawUrl);
  const headerName = environment["AI_DM_WAKE_WEBHOOK_HEADER"]?.trim() || "Authorization";
  const scheme =
    environment["AI_DM_WAKE_WEBHOOK_SCHEME"] === undefined
      ? "Bearer"
      : environment["AI_DM_WAKE_WEBHOOK_SCHEME"].trim();
  const secret = environment["AI_DM_WAKE_WEBHOOK_SECRET"]?.trim() || null;
  const debounce = parseDuration(
    environment["AI_DM_WAKE_DEBOUNCE_MS"],
    "AI_DM_WAKE_DEBOUNCE_MS",
    DEFAULT_DEBOUNCE_MS,
    30_000,
  );
  const maxWait = parseDuration(
    environment["AI_DM_WAKE_MAX_WAIT_MS"],
    "AI_DM_WAKE_MAX_WAIT_MS",
    DEFAULT_MAX_WAIT_MS,
    120_000,
  );
  const playersOnly = parseFlag(environment["AI_DM_WAKE_PLAYERS_ONLY"], true);
  const roomCrossingsOnly = parseFlag(environment["AI_DM_WAKE_ROOM_CROSSINGS_ONLY"], false);
  const chat = parseFlag(environment["AI_DM_WAKE_CHAT"], true);
  const combatTurns = parseFlag(environment["AI_DM_WAKE_COMBAT_TURNS"], false);
  const problem =
    url.problem ??
    headerProblem(headerName) ??
    credentialProblem(secret, scheme) ??
    debounce.problem ??
    maxWait.problem ??
    playersOnly.problem ??
    roomCrossingsOnly.problem ??
    chat.problem ??
    combatTurns.problem;

  return {
    enabled: problem === undefined,
    url: url.href,
    secret,
    headerName,
    scheme,
    debounceMs: debounce.value,
    // The cap can never be shorter than the quiet period it bounds.
    maxWaitMs: Math.max(maxWait.value, debounce.value),
    playersOnly: playersOnly.value,
    roomCrossingsOnly: roomCrossingsOnly.value,
    chat: chat.value,
    combatTurns: combatTurns.value,
    ...(problem ? { problem } : {}),
  };
}

export function wakeCredentialHeader(
  config: WakeWebhookConfig,
): { name: string; value: string } | undefined {
  if (!config.secret) return undefined;
  return {
    name: config.headerName,
    value: config.scheme ? `${config.scheme} ${config.secret}` : config.secret,
  };
}

function parseUrl(raw: string): { href: string | null; problem?: string } {
  if (raw.length > DEFAULT_LIMIT)
    return { href: null, problem: "AI_DM_WAKE_WEBHOOK_URL is too long." };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { href: null, problem: "AI_DM_WAKE_WEBHOOK_URL must be an http(s) URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { href: null, problem: "AI_DM_WAKE_WEBHOOK_URL must use http or https." };
  if (parsed.username || parsed.password)
    return { href: null, problem: "AI_DM_WAKE_WEBHOOK_URL must not embed credentials." };
  if (!parsed.hostname)
    return { href: null, problem: "AI_DM_WAKE_WEBHOOK_URL must include a host." };
  return { href: parsed.href };
}

function headerProblem(name: string): string | undefined {
  if (!HEADER_NAME.test(name) || BLOCKED_HEADERS.has(name.toLowerCase()))
    return "AI_DM_WAKE_WEBHOOK_HEADER must be a single application header name.";
  return undefined;
}

function credentialProblem(secret: string | null, scheme: string): string | undefined {
  if (secret && (secret.length > 512 || /[\r\n]/.test(secret)))
    return "AI_DM_WAKE_WEBHOOK_SECRET must be one line of at most 512 characters.";
  if (scheme.length > 64 || /[\r\n]/.test(scheme))
    return "AI_DM_WAKE_WEBHOOK_SCHEME must be one line of at most 64 characters.";
  return undefined;
}

function parseDuration(
  raw: string | undefined,
  name: string,
  fallback: number,
  max: number,
): { value: number; problem?: string } {
  if (!raw?.trim()) return { value: fallback };
  const problem = `${name} must be an integer from 0 through ${max}.`;
  if (!/^\d+$/.test(raw.trim())) return { value: fallback, problem };
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0 || value > max) return { value: fallback, problem };
  return { value };
}

function parseFlag(
  raw: string | undefined,
  fallback: boolean,
): { value: boolean; problem?: string } {
  if (!raw?.trim()) return { value: fallback };
  if (raw === "true") return { value: true };
  if (raw === "false") return { value: false };
  return { value: fallback, problem: "Wake webhook flags must be true or false." };
}
