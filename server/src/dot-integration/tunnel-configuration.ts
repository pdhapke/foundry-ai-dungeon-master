import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { GenericBridge } from "./api-contract.js";
import { createWindowsPrivateStorageVerifier, type PrivateStorageVerifier } from "./windows-security.js";
import { dotProductionConfigSchema } from "./production.js";
import { TunnelActivationFailure, type TunnelLifecycle, type TunnelLifecycleStatus } from "./tunnel-lifecycle.js";

export const TUNNEL_CONFIGURATION_KIND = "dot-tunnel-configuration";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const tunnelControllerSchema = z.object({ worldId: id, sceneId: id, clientId: id, userId: id }).strict();
export type TunnelController = z.infer<typeof tunnelControllerSchema>;
const inputSchema = z.object({ kind: z.literal(TUNNEL_CONFIGURATION_KIND), requestId: z.string().uuid(), worldId: id,
  action: z.enum(["status", "save", "activate", "stop"]), confirmed: z.literal(true).optional(), tunnelId: z.string().regex(/^tunnel_[a-f0-9]{32}$/).optional(),
  runtimeKey: z.string().min(20).max(4096).regex(/^[\x21-\x7e]+$/).optional(), rotateRuntimeKey: z.literal(true).optional(),
  expectedController: tunnelControllerSchema.optional(),
}).strict();
export interface TunnelConfigurationStatus {
  configured: boolean; runtimeKeyConfigured: boolean; bridgeKeyConfigured: boolean;
  tunnelId?: string; controller: TunnelController; activation: "inactive" | "active"; message: string;
  lifecycle?: TunnelLifecycleStatus;
}
export interface TunnelConfigurationStorage {
  status(controller: TunnelController): TunnelConfigurationStatus;
  save(controller: TunnelController, tunnelId: string, runtimeKey: string | undefined, rotate: boolean): void;
}
const profile = (root: string, tunnelId: string): string => {
  const path = root.replaceAll("\\", "/");
  return `config_version: 1\ncontrol_plane:\n  base_url: https://api.openai.com\n  tunnel_id: ${tunnelId}\n  api_key: file:${path}/runtime-key.txt\n  poll_channels: [main]\nmcp:\n  server_urls:\n    - channel: main\n      url: http://127.0.0.1:3939/dot/mcp\n  extra_headers:\n    x-foundry-dot-key: file:${path}/dot-key.txt\n  discovery_extra_headers:\n    x-foundry-dot-key: file:${path}/dot-key.txt\n`;
};
export const configurationErrors = {
  invalid_input: "Configuration input is invalid. Use the tunnel ID and runtime key exactly as supplied; keys must be 20–4096 printable ASCII characters with no spaces or line breaks.",
  private_storage_unavailable: "Protected tunnel storage could not be verified. Ask the local operator to check the folder and private permissions.",
  profile_conflict: "The existing tunnel profile differs from the supported profile. It was preserved; local operator review is required.",
  recovery_required: "An interrupted configuration save requires local review. The recovery marker was preserved; do not enter another key.",
  controller_mismatch: "The saved controller belongs to another GM, scene, or browser. Existing configuration was preserved; local operator review is required.",
  replacement_required: "A runtime key is already saved. Leave the key field blank to keep it, or explicitly confirm replacement.",
  runtime_key_required: "No runtime key is saved. Enter the OpenAI tunnel runtime key before saving.",
  rotation_invalid: "Key replacement needs an existing saved key and a new key value.",
  retained_events: "Existing event state requires local review before changing tunnel configuration.",
  bridge_key_conflict: "The existing bridge key and configuration do not match. Both were preserved; local operator review is required.",
  scope_changed: "The displayed GM, scene, or browser scope changed. Refresh status before saving.",
  scope_unavailable: "The current GM scene could not be verified. Check the GM connection and viewed scene, then refresh status.",
  activation_loaded: "Tunnel service configuration is already loaded. Stop it through the supported launcher before changing configuration.",
  busy: "Another configuration request is running. Wait for completion, then refresh status.",
  save_failed: "The save did not complete. Local review of the recovery marker is required before another save.",
} as const;
type ConfigurationErrorCode = keyof typeof configurationErrors;
class ConfigurationFailure extends Error {
  constructor(readonly code: ConfigurationErrorCode) { super(configurationErrors[code]); }
}
const safeFailure = (code: ConfigurationErrorCode = "private_storage_unavailable"): Error => new ConfigurationFailure(code);

/** Server-only protected files. No mkdir/ACL changes, credential echo, backups,
 * environment changes, runtime launches or subscriptions. Config is committed
 * last; partial writes never activate the service. Unknown existing files and
 * changed controller scope are preserved for reviewed recovery. */
export class ProtectedTunnelConfigurationStorage implements TunnelConfigurationStorage {
  private verifiedRead: ReadonlySet<string> | undefined;
  constructor(readonly root = join(homedir(), "AppData", "Local", "FoundryDot"),
    private readonly assertPrivate: PrivateStorageVerifier = createWindowsPrivateStorageVerifier(root),
    private readonly io: { write(fd: number, bytes: Buffer): void; flush(fd: number): void; rename(from: string, to: string): void } = {
      write: (fd, bytes) => { writeFileSync(fd, bytes); }, flush: fsyncSync, rename: renameSync,
    }) {}
  private path(name: string): string { return join(this.root, name); }
  /** Fresh synchronous attestation, discarded before returning. No TTL authority
   * cache; mutations and each later operation still verify their own paths. */
  private withVerifiedRead<T>(operation: () => T): T {
    const paths = ["configuration.lock", "dot-config.json", "tunnel-profile.yaml", "runtime-key.txt", "dot-key.txt"].map(name => this.path(name));
    if (paths.every(path => this.verifiedRead?.has(path)) || !this.assertPrivate.verifyMany) return operation();
    this.assertPrivate.verifyMany(paths);
    const previous = this.verifiedRead; this.verifiedRead = new Set(paths);
    try { return operation(); } finally { this.verifiedRead = previous; }
  }
  private checked(name: string): string {
    const path = this.path(name); if (!this.verifiedRead?.has(path)) this.assertPrivate(path);
    if (existsSync(path)) { const stat = statSync(path); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw safeFailure(); }
    return path;
  }
  private config(): z.infer<typeof dotProductionConfigSchema> | undefined {
    const path = this.checked("dot-config.json");
    if (!existsSync(path)) return;
    const parsed = dotProductionConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success || parsed.data.privateDirectory !== this.root || parsed.data.owner !== "peter-local") throw safeFailure();
    return parsed.data;
  }
  private tunnelId(): string | undefined {
    const path = this.checked("tunnel-profile.yaml"); if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n"), tunnelId = /^ {2}tunnel_id: (tunnel_[a-f0-9]{32})$/m.exec(text)?.[1];
    if (!tunnelId || text.trim() !== profile(this.root, tunnelId).trim()) throw safeFailure("profile_conflict");
    return tunnelId;
  }
  status(controller: TunnelController): TunnelConfigurationStatus {
    return this.withVerifiedRead(() => this.readStatus(controller));
  }
  private readStatus(controller: TunnelController): TunnelConfigurationStatus {
    if (existsSync(this.checked("configuration.lock"))) throw safeFailure("recovery_required");
    const config = this.config(), tunnelId = this.tunnelId();
    const runtimeKeyConfigured = existsSync(this.checked("runtime-key.txt")), bridgeKeyConfigured = existsSync(this.checked("dot-key.txt"));
    return { configured: !!config && !!tunnelId && runtimeKeyConfigured && bridgeKeyConfigured,
      runtimeKeyConfigured, bridgeKeyConfigured, ...(tunnelId ? { tunnelId } : {}), controller,
      activation: "inactive", message: config && JSON.stringify(config.controller) !== JSON.stringify(controller)
        ? "Saved controller differs from this GM or scene. Review the existing scope before changing it."
        : "Save stores local configuration only. Activate separately after protected files, current controller, dot mode and pinned tools verify. The dedicated dot key does not grant administrative API access." };
  }
  activationProfile(controller: TunnelController): string {
    return this.withVerifiedRead(() => this.readActivationProfile(controller));
  }
  private readActivationProfile(controller: TunnelController): string {
    const status = this.status(controller), config = this.config();
    if (!status.configured || !config) throw safeFailure();
    if (JSON.stringify(config.controller) !== JSON.stringify(controller)) throw safeFailure("controller_mismatch");
    const key = readFileSync(this.checked("dot-key.txt"));
    try {
      if (!/^fdot_[A-Za-z0-9_-]{43}$/.test(key.toString("utf8")) || createHash("sha256").update(key).digest("hex") !== config.credentialSha256) throw safeFailure("bridge_key_conflict");
    } finally { key.fill(0); }
    const size = statSync(this.checked("runtime-key.txt")).size;
    if (size < 20 || size > 4096) throw safeFailure("invalid_input");
    return this.checked("tunnel-profile.yaml");
  }
  private write(name: string, bytes: Buffer, replace: boolean): void {
    const path = this.checked(name); if (existsSync(path) && !replace) throw safeFailure();
    const temporaryName = `.${name}.${randomUUID()}.tmp`, temporary = this.path(temporaryName);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      this.assertPrivate(temporary); this.io.write(fd, bytes); this.io.flush(fd); closeSync(fd); fd = undefined;
      this.assertPrivate(temporary); if (statSync(temporary).size !== bytes.length) throw safeFailure(); this.checked(name);
      if (!replace && existsSync(path)) throw safeFailure();
      this.io.rename(temporary, path); this.checked(name);
    } finally {
      if (fd !== undefined) closeSync(fd);
      // Only this invocation's exact generated private file is eligible.
      if (existsSync(temporary)) { this.checked(temporaryName); unlinkSync(temporary); }
    }
  }
  save(controller: TunnelController, tunnelId: string, runtimeKey: string | undefined, rotate: boolean): void {
    if (!tunnelControllerSchema.safeParse(controller).success || !/^tunnel_[a-f0-9]{32}$/.test(tunnelId) || (runtimeKey !== undefined && (runtimeKey.length < 20 || runtimeKey.length > 4096 || !/^[\x21-\x7e]+$/.test(runtimeKey)))) throw safeFailure();
    const lock = this.checked("configuration.lock"); if (existsSync(lock)) throw safeFailure("recovery_required");
    const fd = openSync(lock, "wx", 0o600);
    let key: Buffer | undefined, runtime: Buffer | undefined;
    let writesAttempted = false, completed = false;
    try {
      this.assertPrivate(lock);
      writeFileSync(fd, Buffer.from(JSON.stringify({ version: 1, operationId: randomUUID(), recovery: "Review interrupted configuration before retiring this marker." }), "utf8")); fsyncSync(fd);
      const config = this.config(); this.tunnelId();
      if (config && JSON.stringify(config.controller) !== JSON.stringify(controller)) throw safeFailure("controller_mismatch");
      if (existsSync(this.checked("dot-events.json"))) throw safeFailure("retained_events");
      const runtimeExists = existsSync(this.checked("runtime-key.txt"));
      if (runtimeExists && runtimeKey !== undefined && !rotate) throw safeFailure("replacement_required");
      if (rotate && (!runtimeExists || runtimeKey === undefined)) throw safeFailure("rotation_invalid");
      if (!runtimeExists && runtimeKey === undefined) throw safeFailure("runtime_key_required");
      const keyPath = this.checked("dot-key.txt"), keyExists = existsSync(keyPath);
      key = keyExists ? readFileSync(keyPath) : Buffer.from(`fdot_${randomBytes(32).toString("base64url")}`, "utf8");
      if (!/^fdot_[A-Za-z0-9_-]{43}$/.test(key.toString("utf8"))) throw safeFailure("bridge_key_conflict");
      const credentialSha256 = createHash("sha256").update(key).digest("hex");
      if (config && config.credentialSha256 !== credentialSha256) throw safeFailure("bridge_key_conflict");
      const next = dotProductionConfigSchema.parse({ version: 1, enabled: true, mode: "private-tunnel-single-user", owner: "peter-local", controller, privateDirectory: this.root, credentialSha256 });
      writesAttempted = true;
      if (!keyExists) this.write("dot-key.txt", key, false);
      if (runtimeKey !== undefined) { runtime = Buffer.from(runtimeKey, "utf8"); this.write("runtime-key.txt", runtime, rotate); }
      this.write("tunnel-profile.yaml", Buffer.from(profile(this.root, tunnelId), "utf8"), existsSync(this.path("tunnel-profile.yaml")));
      this.write("dot-config.json", Buffer.from(JSON.stringify(next, null, 2), "utf8"), !!config);
      completed = true;
    } catch (error) { throw writesAttempted ? safeFailure("save_failed") : error instanceof ConfigurationFailure ? error : safeFailure(); }
    finally {
      key?.fill(0); runtime?.fill(0); closeSync(fd);
      // Failed/uncertain file mutations retain a nonsecret durable recovery
      // marker. Never silently retry, roll back secrets or reclaim this lock.
      if (completed || !writesAttempted) { this.checked("configuration.lock"); unlinkSync(lock); }
    }
  }
}

type Sender = { clientId: string; userId: string; lane: string };
/** Private gateway handler; never a Foundry event, RPC, audit payload or trace. */
export class TunnelConfigurationService {
  private busy = false;
  constructor(private readonly storage: TunnelConfigurationStorage,
    private readonly gateway: Pick<GenericBridge, "getVerifiedFoundryIdentity" | "send">,
    private readonly readController: (sender: Sender) => Promise<unknown>, private readonly allowedWorldId = "mcp-test",
    private readonly activationLoaded: () => boolean = () => false, private readonly lifecycle?: TunnelLifecycle) {}
  async handle(raw: unknown, sender: Sender, stillConnected: () => boolean): Promise<void> {
    const parsed = inputSchema.safeParse(raw);
    const envelope = z.object({ kind: z.literal(TUNNEL_CONFIGURATION_KIND), requestId: z.string().uuid(), worldId: id }).passthrough().safeParse(raw);
    if (raw && typeof raw === "object") Reflect.deleteProperty(raw, "runtimeKey");
    if (!envelope.success) return;
    const request = envelope.data;
    const authorized = (): boolean => {
      const identity = sender.lane === "gm" && stillConnected() ? this.gateway.getVerifiedFoundryIdentity({ clientId: sender.clientId, userId: sender.userId, lane: "gm" }) : null;
      return !!identity && request.worldId === this.allowedWorldId && identity.worldId === request.worldId && identity.userId === sender.userId && identity.role === 4 && identity.isGM;
    };
    Reflect.deleteProperty(request, "runtimeKey");
    if (!authorized()) { if (parsed.success) delete parsed.data.runtimeKey; return; }
    if (!parsed.success || this.busy) {
      if (parsed.success) delete parsed.data.runtimeKey;
      this.reply(sender.clientId, request.requestId, undefined, !parsed.success ? "invalid_input" : "busy"); return;
    }
    const input = parsed.data;
    this.busy = true;
    try {
      if ((input.action === "status" && (input.runtimeKey !== undefined || input.tunnelId !== undefined || input.rotateRuntimeKey || input.expectedController || input.confirmed)) ||
        (input.action === "save" && (!input.tunnelId || !input.expectedController || input.confirmed)) ||
        (["activate", "stop"].includes(input.action) && (input.runtimeKey !== undefined || input.tunnelId !== undefined || input.rotateRuntimeKey || !input.expectedController || !input.confirmed || !this.lifecycle))) throw safeFailure("invalid_input");
      const readScope = async (): Promise<TunnelController> => {
        try { return tunnelControllerSchema.parse(await this.readController(sender)); }
        catch { throw safeFailure("scope_unavailable"); }
      };
      const scope = await readScope();
      if (!authorized() || scope.worldId !== input.worldId || scope.clientId !== sender.clientId || scope.userId !== sender.userId) throw safeFailure("scope_changed");
      if (input.action !== "status") {
        if (JSON.stringify(input.expectedController) !== JSON.stringify(scope)) throw safeFailure("scope_changed");
        const current = await readScope();
        if (!authorized() || JSON.stringify(current) !== JSON.stringify(scope)) throw safeFailure("scope_changed");
      }
      if (input.action === "save") {
        if (this.activationLoaded()) throw safeFailure("activation_loaded");
        this.storage.save(scope, input.tunnelId!, input.runtimeKey, input.rotateRuntimeKey === true);
      }
      const lifecycle = input.action === "activate" ? await this.lifecycle!.activate(scope, authorized)
        : input.action === "stop" ? await this.lifecycle!.stop(scope) : await this.lifecycle?.status(scope);
      if (authorized()) this.reply(sender.clientId, input.requestId, { ...this.storage.status(scope), activation: lifecycle?.phase === "running" ? "active" : "inactive", ...(lifecycle ? { lifecycle } : {}) });
    } catch (error) {
      if (authorized()) this.reply(sender.clientId, input.requestId, undefined, error instanceof ConfigurationFailure ? error.code : error instanceof TunnelActivationFailure && error.reason === "busy" ? "busy" : "private_storage_unavailable");
    } finally { delete input.runtimeKey; this.busy = false; }
  }
  private reply(clientId: string, requestId: string, status: TunnelConfigurationStatus | undefined, errorCode: ConfigurationErrorCode = "private_storage_unavailable"): void {
    this.gateway.send(JSON.stringify({ kind: "dot-tunnel-configuration-status", clientId, requestId,
      ...(status ? { status } : { errorCode, error: configurationErrors[errorCode] }) }), { clientId, lane: "gm" });
  }
}
