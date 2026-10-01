import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environmentPath = resolve(serverRoot, ".env");
loadDotenv({ path: environmentPath, quiet: true });

export interface AiDmServerConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  nodeEnv: "development" | "test" | "production";
  runtimeRoot: string;
  campaignRoot: string;
  sourceBookRoot: string | null;
  foundryLocalApiBaseUrl: string;
  foundryLocalApiKey: string | null;
  foundryBrokerSecret: string | null;
  allowedFoundryOrigins: string[];
  openAiApiKey: string | null;
  openAiApiKeyFallbackEnabled: boolean;
  openAiModel: string;
  signingKey: string;
  signingKeyEphemeral: boolean;
  chatkitPython: string;
  chatkitPort: number;
  chatkitDatabasePath: string;
  chatkitAuth: "existing" | "api-key";
}

export class AiDmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiDmConfigError";
  }
}

function parsePort(raw: string | undefined, defaultPort = 3940): number {
  if (!raw) return defaultPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AiDmConfigError("AI_DM_PORT must be an integer from 1 through 65535.");
  }
  return port;
}

function parseNodeEnv(raw: string | undefined): AiDmServerConfig["nodeEnv"] {
  if (!raw) return "development";
  if (raw === "development" || raw === "test" || raw === "production") return raw;
  throw new AiDmConfigError("NODE_ENV must be development, test, or production.");
}

function parseLoopbackHost(raw: string | undefined): AiDmServerConfig["host"] {
  if (!raw || raw === "127.0.0.1") return "127.0.0.1";
  if (raw === "::1") return "::1";
  throw new AiDmConfigError("The AI Dungeon Master server only binds to loopback.");
}

function parseLoopbackUrl(raw: string | undefined): string {
  const value = raw ?? "http://127.0.0.1:3939";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AiDmConfigError("FOUNDRY_LOCAL_API_URL must be a valid loopback HTTP URL.");
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "[::1]")
  ) {
    throw new AiDmConfigError("FOUNDRY_LOCAL_API_URL must use HTTP on a loopback host.");
  }
  return parsed.href.replace(/\/$/, "");
}

function optionalSecret(raw: string | undefined, name: string, minimum: number): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  if (value.length < minimum) throw new AiDmConfigError(`${name} is too short.`);
  return value;
}

function provisionSigningKey(environment: NodeJS.ProcessEnv): string | null {
  const existing = optionalSecret(environment["AI_DM_SIGNING_KEY"], "AI_DM_SIGNING_KEY", 32);
  if (existing || environment !== process.env) return existing;
  const generated = randomBytes(32).toString("hex");
  const contents = existsSync(environmentPath) ? readFileSync(environmentPath, "utf8") : "";
  const keyLine = /^AI_DM_SIGNING_KEY=.*$/m;
  const updated = keyLine.test(contents)
    ? contents.replace(keyLine, `AI_DM_SIGNING_KEY=${generated}`)
    : `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}AI_DM_SIGNING_KEY=${generated}\n`;
  writeFileSync(environmentPath, updated, { encoding: "utf8", mode: 0o600 });
  environment["AI_DM_SIGNING_KEY"] = generated;
  return generated;
}

function parseBoolean(raw: string | undefined, name: string): boolean {
  if (!raw?.trim()) return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new AiDmConfigError(`${name} must be true or false.`);
}

function parseFoundryOrigins(raw: string | undefined): string[] {
  const values = (raw ?? "http://127.0.0.1:30000,http://localhost:30000,http://[::1]:30000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length > 8) {
    throw new AiDmConfigError("AI_DM_FOUNDRY_ORIGINS must contain one to eight exact origins.");
  }
  return values.map((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AiDmConfigError("AI_DM_FOUNDRY_ORIGINS contains an invalid origin.");
    }
    if (parsed.origin !== value || !["http:", "https:"].includes(parsed.protocol)) {
      throw new AiDmConfigError("AI_DM_FOUNDRY_ORIGINS entries must be exact HTTP(S) origins.");
    }
    return parsed.origin;
  });
}

export function loadAiDmServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AiDmServerConfig {
  const nodeEnv = parseNodeEnv(environment["NODE_ENV"]);
  const configuredSigningKey = provisionSigningKey(environment);
  if (nodeEnv === "production" && !configuredSigningKey) {
    throw new AiDmConfigError("AI_DM_SIGNING_KEY is required in production.");
  }
  const openAiApiKeyFallbackEnabled = parseBoolean(
    environment["AI_DM_ENABLE_API_KEY_FALLBACK"],
    "AI_DM_ENABLE_API_KEY_FALLBACK",
  );
  const foundryBrokerSecret = optionalSecret(
    environment["AI_DM_FOUNDRY_BROKER_SECRET"],
    "AI_DM_FOUNDRY_BROKER_SECRET",
    32,
  );
  if (nodeEnv === "production" && !foundryBrokerSecret) {
    throw new AiDmConfigError(
      "AI_DM_FOUNDRY_BROKER_SECRET is required; start the AI server through Foundry.",
    );
  }
  const moduleRoot = resolve(serverRoot, "..");
  const chatkitAuth = environment["AI_DM_CHATKIT_AUTH"] || "existing";
  if (chatkitAuth !== "existing" && chatkitAuth !== "api-key") {
    throw new AiDmConfigError("AI_DM_CHATKIT_AUTH must be existing or api-key.");
  }
  const runtimeRoot = resolve(environment["AI_DM_RUNTIME_ROOT"] ?? resolve(moduleRoot, ".runtime"));
  return {
    host: parseLoopbackHost(environment["AI_DM_HOST"]),
    port: parsePort(environment["AI_DM_PORT"]),
    nodeEnv,
    runtimeRoot,
    chatkitAuth,
    chatkitPython:
      environment["AI_DM_CHATKIT_PYTHON"] ||
      resolve(
        moduleRoot,
        "chatkit-server",
        ".venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      ),
    chatkitPort: parsePort(environment["AI_DM_CHATKIT_PORT"], 3941),
    chatkitDatabasePath: resolve(
      environment["AI_DM_CHATKIT_DATABASE_PATH"] ??
        resolve(runtimeRoot, "ai-dungeon-master", "chatkit.sqlite"),
    ),
    campaignRoot: resolve(
      environment["AI_DM_CAMPAIGN_ROOT"] ?? resolve(moduleRoot, "../../../../campaign"),
    ),
    sourceBookRoot: environment["AI_DM_SOURCEBOOK_ROOT"]
      ? resolve(environment["AI_DM_SOURCEBOOK_ROOT"])
      : null,
    foundryLocalApiBaseUrl: parseLoopbackUrl(environment["FOUNDRY_LOCAL_API_URL"]),
    foundryLocalApiKey: optionalSecret(
      environment["FOUNDRY_LOCAL_API_KEY"],
      "FOUNDRY_LOCAL_API_KEY",
      16,
    ),
    foundryBrokerSecret,
    allowedFoundryOrigins: parseFoundryOrigins(environment["AI_DM_FOUNDRY_ORIGINS"]),
    openAiApiKey: openAiApiKeyFallbackEnabled
      ? optionalSecret(environment["OPENAI_API_KEY"], "OPENAI_API_KEY", 20)
      : null,
    openAiApiKeyFallbackEnabled,
    openAiModel: environment["OPENAI_MODEL"]?.trim() || "gpt-5.4",
    signingKey: configuredSigningKey ?? randomBytes(32).toString("hex"),
    signingKeyEphemeral: configuredSigningKey === null,
  };
}
