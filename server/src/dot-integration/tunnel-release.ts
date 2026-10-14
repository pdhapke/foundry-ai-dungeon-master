/** Reviewed release assets, not a mutable latest-release lookup. Full bundle
 * retains the pinned cloudflared companion, notices, licenses and SPDX inventory.
 * Source: https://github.com/openai/tunnel-client/releases/expanded_assets/v0.0.16
 */
export const TUNNEL_RELEASE = "v0.0.16";
export interface TunnelRelease { release: string; platform: string; archive: string; sha256: string; bytes: number; sbomSha256: string }
export const TUNNEL_RELEASES: Readonly<Record<string, TunnelRelease>> = Object.freeze({
  x64: Object.freeze({ release: TUNNEL_RELEASE, platform: "windows-amd64", archive: "tunnel-client-v0.0.16-windows-amd64.zip", sha256: "edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6", bytes: 28122468, sbomSha256: "4a4852a97ee25d7f72b6ffc54378e57b72b4047959c1d9eede6606efece10bd5" }),
  arm64: Object.freeze({ release: TUNNEL_RELEASE, platform: "windows-arm64", archive: "tunnel-client-v0.0.16-windows-arm64.zip", sha256: "ecd748288b9bd9cc8f5a963855eb143f4788b831475156703d0bafdcd2dcb149", bytes: 25495576, sbomSha256: "82fd4aa16ae1d0646d113028778c5d9cfd90ea953c877915075c0572cb888fbc" }),
});
/** Retain reviewed prior manifests here when changing the required pin, so the
 * explicit rollback action can verify their complete bundles without a download.
 * Never populate this catalog from remote latest-release metadata. */
export const REVIEWED_TUNNEL_RELEASES: readonly TunnelRelease[] = Object.freeze(Object.values(TUNNEL_RELEASES));
export const tunnelReleaseUrl = (release: TunnelRelease): string => `https://github.com/openai/tunnel-client/releases/download/${release.release}/${release.archive}`;
export const tunnelReleaseFiles = (release: TunnelRelease): string[] => ["tunnel-client.exe", "cloudflared.exe", "cloudflared-manifest.json", "LICENSE", "NOTICE", `${release.archive.slice(0, -4)}-licenses.txt`, `${release.archive.slice(0, -4)}.spdx.json`];

export class TunnelInstallError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TunnelInstallError"; }
}
