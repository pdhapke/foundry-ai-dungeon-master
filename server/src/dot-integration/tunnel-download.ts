import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { isPublicAddress } from "../../../../foundry-local-api/server/events-core.js";
import { REVIEWED_TUNNEL_RELEASES, TunnelInstallError, tunnelReleaseUrl, type TunnelRelease } from "./tunnel-release.js";

/** Node 24's automatic family selection asks custom lookup for all addresses.
 * Both callback shapes still return only our already-checked pinned address. */
export const pinnedTunnelLookup = (address: { address: string; family: number }): LookupFunction => (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family);

export function allowedTunnelDownloadUrl(value: string, initial: string, redirect: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new TunnelInstallError("network", "Official release URL was refused."); }
  if (value.length > 8192 || url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
    (!redirect && (url.href !== initial || url.hostname !== "github.com" || url.search || !REVIEWED_TUNNEL_RELEASES.some(pin => tunnelReleaseUrl(pin) === initial))) || (redirect && url.hostname !== "release-assets.githubusercontent.com"))
    throw new TunnelInstallError("network", "Official release redirect was refused.");
  return url;
}
async function resolveOfficial(hostname: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  let cancel: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await Promise.race([lookup(hostname, { all: true }), new Promise<never>((_resolve, reject) => { cancel = () => reject(new TunnelInstallError("cancelled", "Official release lookup timed out or was canceled. Retry from Foundry setup.")); signal.addEventListener("abort", cancel, { once: true }); })]);
  } finally { if (cancel) signal.removeEventListener("abort", cancel); }
}
/** No authorization headers, cookies, proxies, shell commands or secret logging. */
export async function downloadTunnelRelease(release: TunnelRelease, external: AbortSignal): Promise<Buffer> {
  const signal = AbortSignal.any([external, AbortSignal.timeout(120000)]), initial = tunnelReleaseUrl(release);
  let target = initial;
  for (let redirects = 0; redirects <= 1; redirects++) {
    signal.throwIfAborted(); const url = allowedTunnelDownloadUrl(target, initial, redirects !== 0);
    const addresses = await resolveOfficial(url.hostname, signal); signal.throwIfAborted();
    if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) throw new TunnelInstallError("network", "Official release DNS was refused.");
    const address = addresses[0]!;
    const result = await new Promise<{ data?: Buffer; redirect?: string }>((resolve, reject) => {
      const req = request(url, { method: "GET", agent: false, signal,
        headers: { "User-Agent": "foundry-local-api-tunnel-setup", Accept: "application/octet-stream" },
        lookup: pinnedTunnelLookup(address),
      }, response => {
        if (response.statusCode === 302 && redirects === 0 && response.headers.location) { response.resume(); resolve({ redirect: response.headers.location }); return; }
        if (response.statusCode !== 200 || (response.headers["content-length"] && Number(response.headers["content-length"]) !== release.bytes) || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
          response.destroy(); reject(new TunnelInstallError("network", "Official release is unavailable. Check internet/proxy access and retry from Foundry setup.")); return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > release.bytes || bytes > 32 * 1024 * 1024) { response.destroy(); reject(new TunnelInstallError("download_size", "Official release exceeded its size bound.")); } else chunks.push(chunk); });
        response.on("error", () => reject(new TunnelInstallError("network", "Download interrupted. Check internet access and retry from Foundry setup.")));
        response.on("end", () => bytes === release.bytes ? resolve({ data: Buffer.concat(chunks) }) : reject(new TunnelInstallError("download_size", "Official release download was incomplete.")));
      });
      req.on("error", () => reject(new TunnelInstallError(signal.aborted ? "cancelled" : "network", signal.aborted ? "Installation canceled; retry from Foundry setup." : "Unable to download the official release. Check internet/proxy access and retry from Foundry setup.")));
      req.end();
    });
    if (result.data) return result.data;
    target = result.redirect!;
  }
  throw new TunnelInstallError("network", "Official release exceeded its redirect bound.");
}
