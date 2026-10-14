import { z } from "zod";
import type { GenericBridge } from "./api-contract.js";
import type { TunnelToolInstaller } from "./tunnel-install.js";
import { TunnelInstallError } from "./tunnel-release.js";

export const TUNNEL_SETUP_EVENT = "foundry.dot_tunnel_tool_setup";
const inputSchema = z.object({ requestId: z.string().uuid(), worldId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), action: z.enum(["status", "enable", "disable", "install", "rollback"]), confirmed: z.boolean().optional() }).strict();
type Identity = { clientId: string; userId: string; lane: string };
/** Local verified-GM setup only. Never exposed in REST, administrative MCP, or
 * scoped dot catalogs. Browser requests contain no version, path, URL or secret.
 */
export class TunnelSetupService {
  private owner: string | undefined;
  private ownerClientId: string | undefined;
  constructor(readonly installer: TunnelToolInstaller, private readonly gateway: Pick<GenericBridge, "getVerifiedFoundryIdentity" | "send">) {}
  async handle(raw: unknown, sender: Identity): Promise<void> {
    const parsed = inputSchema.safeParse(raw); if (!parsed.success) return;
    const input = parsed.data;
    const authorized = (): boolean => {
      if (sender.lane !== "gm") return false;
      const identity = this.gateway.getVerifiedFoundryIdentity({ clientId: sender.clientId, userId: sender.userId, lane: "gm" });
      return identity?.worldId === input.worldId && identity.userId === sender.userId && identity.role === 4 && identity.isGM === true;
    };
    if (!authorized()) return;
    const owner = JSON.stringify([input.worldId, sender.clientId, sender.userId]);
    try {
      if (input.action !== "status" && this.owner && this.owner !== owner) throw new TunnelInstallError("busy", "Another verified GM owns this setup session. Ask that GM to disable downloads, or restart the companion through the supported launcher.");
      if (!["install", "rollback"].includes(input.action) && input.confirmed !== undefined) throw new TunnelInstallError("invalid", "Unexpected setup confirmation.");
      if (input.action === "enable") { this.owner = owner; this.ownerClientId = sender.clientId; this.installer.setEnabled(true); }
      if (input.action === "disable") this.stop();
      if (input.action === "install" || input.action === "rollback") {
        if (input.confirmed !== true || this.owner !== owner) throw new TunnelInstallError("disabled", "Enable session downloads and explicitly confirm installation in Foundry setup.");
        if (input.action === "install") await this.installer.install(authorized, new AbortController().signal);
        else await this.installer.rollback(authorized, new AbortController().signal);
      }
      if (authorized()) this.reply(sender.clientId, input.requestId, input.action === "status" ? this.installer.displayStatus() : this.installer.status());
    } catch (error) {
      if (authorized()) { const failure = error instanceof TunnelInstallError ? error : new TunnelInstallError("setup", "Foundry tunnel tool setup failed. Check status and contact the local operator."); this.reply(sender.clientId, input.requestId, { ...this.installer.status(), errorCode: failure.code, message: failure.message }); }
    }
  }
  private reply(clientId: string, requestId: string, status: unknown): void { this.gateway.send(JSON.stringify({ kind: "dot-tunnel-tool-status", clientId, requestId, status }), { clientId, lane: "gm" }); }
  disconnected(clientId: string): void { if (this.ownerClientId === clientId) this.stop(); }
  stop(): void { this.installer.setEnabled(false); this.owner = undefined; this.ownerClientId = undefined; }
}
