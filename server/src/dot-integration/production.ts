import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Request } from "express";
import type { GenericBridge } from "./api-contract.js";
import { DotMcpError } from "./contract.js";
import type { EventSecretCodec as DotSecretCodec } from "../../../../foundry-local-api/server/events-core.js";
import type { DotController, DotIntegrationSetup } from "./runtime.js";
import { createWindowsPrivateStorageVerifier, WindowsDpapiCodec } from "./windows-security.js";

export const DOT_LOCAL_KEY_HEADER = "x-foundry-dot-key";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const controller = z.object({ worldId: identifier, sceneId: identifier, clientId: identifier, userId: identifier }).strict();
const disabled = z.object({ version: z.literal(1), enabled: z.literal(false) }).strict();
export const dotProductionConfigSchema = z.object({ version: z.literal(1), enabled: z.literal(true),
  mode: z.literal("private-tunnel-single-user"), owner: z.string().regex(/^[A-Za-z0-9_.:@-]{1,256}$/),
  controller, privateDirectory: z.string().max(4096), credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type ProductionConfig = z.infer<typeof dotProductionConfigSchema>;
const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const same = (a: DotController, b: DotController): boolean => a.worldId === b.worldId && a.sceneId === b.sceneId && a.clientId === b.clientId && a.userId === b.userId;
export function isDotLoopbackPeer(value: string | undefined): boolean { return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"; }

/** One dedicated local secret maps to one configured principal. No cloud caller
 * identity is inferred: workspace/tunnel access must be restricted to that user.
 * Header injection occurs at the trusted local tunnel client, never in model args.
 */
export function createDotLocalAuthentication(config: ProductionConfig, active: () => boolean): DotIntegrationSetup["authenticate"] {
  const expected = Buffer.from(config.credentialSha256, "hex");
  // Authentication is synchronous header/digest checking behind a Promise contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (request: Request, signal: AbortSignal): Promise<string | null> => {
    if (signal.aborted || !active() || request.method !== "POST" || request.path !== "/dot/mcp" || !isDotLoopbackPeer(request.socket.remoteAddress)) return null;
    const matching = request.rawHeaders.filter((_value, index, all) => index % 2 === 0 && all[index]!.toLowerCase() === DOT_LOCAL_KEY_HEADER);
    if (matching.length !== 1) return null;
    const provided = request.header(DOT_LOCAL_KEY_HEADER);
    if (!provided || !/^fdot_[A-Za-z0-9_-]{43}$/.test(provided) || !timingSafeEqual(digest(provided), expected)) return null;
    return config.owner;
  };
}

export interface DotProductionDependencies {
  gateway: Pick<GenericBridge, "getVerifiedFoundryIdentity">;
  administrativeCredentialSha256: string;
  bindHost: string;
  /** Test seam only; production defaults perform real read-only Windows checks. */
  read?: (path: string) => string;
  verifier?: (root: string) => (path: string) => void;
  codec?: DotSecretCodec;
}
function readBounded(path: string): string { if (statSync(path).size > 16384) throw new Error(); return readFileSync(path, "utf8"); }
const setupFailure = () => new DotMcpError(-32603, "Dot production setup is incomplete or unsafe; activation refused.");

/** Read-only loader. An absent path is disabled; enabled configuration is never
 * repaired, generated or downgraded to an insecure fallback automatically.
 * Keep the config itself inside the pre-provisioned private directory.
 */
export function loadDotProductionSetup(configPath: string | undefined, dependencies: DotProductionDependencies): DotIntegrationSetup | undefined {
  if (!configPath?.trim()) return;
  const read = dependencies.read ?? readBounded;
  try {
    if (!isAbsolute(configPath)) throw setupFailure();
    const path = resolve(configPath), raw = read(path);
    if (Buffer.byteLength(raw, "utf8") > 16384) throw setupFailure();
    const json: unknown = JSON.parse(raw);
    if (disabled.safeParse(json).success) return;
    const config = dotProductionConfigSchema.parse(json);
    if (!isAbsolute(config.privateDirectory) || dirname(path).toLowerCase() !== resolve(config.privateDirectory).toLowerCase() || !["127.0.0.1", "localhost", "::1"].includes(dependencies.bindHost) || config.credentialSha256 === dependencies.administrativeCredentialSha256) throw setupFailure();
    const assertPrivateStorage = (dependencies.verifier ?? createWindowsPrivateStorageVerifier)(config.privateDirectory);
    assertPrivateStorage(path);
    if (existsSync(join(config.privateDirectory, "configuration.lock"))) throw setupFailure();
    const initialDigest = digest(raw);
    const active = (): boolean => { try { assertPrivateStorage(path); return !existsSync(join(config.privateDirectory, "configuration.lock")) && timingSafeEqual(initialDigest, digest(read(path))); } catch { return false; } };
    if (!active()) throw setupFailure();
    return { enabled: true, owner: config.owner, controller: config.controller,
      authenticate: createDotLocalAuthentication(config, active), active,
      verifyController: (binding, client) => {
        if (!active() || !same(config.controller, binding) || client.clientId !== config.controller.clientId || client.userId !== config.controller.userId || client.lane !== "gm" || !client.isGM) return false;
        const identity = dependencies.gateway.getVerifiedFoundryIdentity({ clientId: binding.clientId, userId: binding.userId, lane: "gm" });
        return identity !== null && identity.worldId === binding.worldId && identity.userId === binding.userId && identity.role === 4 && identity.isGM === true;
      },
      storagePath: join(config.privateDirectory, "dot-events.json"), assertPrivateStorage,
      codec: dependencies.codec ?? new WindowsDpapiCodec(),
    };
  } catch { throw setupFailure(); }
}
