# Campaign storage privacy prerequisite

Inspection date: October 1, 2026. Status: **direct-file privacy FAIL**; protective
deployment is **BLOCKED pending operator approval**. No server, network,
credential, vendor, or existing campaign changes were made during this inspection.

## Evidence

- Installed `App/dist/server/express.mjs` calls its static middleware initializer
  before its session middleware initializer. It registers `express.static` for
  `this.paths.data`. Its filename denylist covers databases and LevelDB files,
  but does not cover Markdown or campaign directories.
- A fresh HTTP client sent only an unauthenticated `HEAD` request, with no cookie
  or authorization header, to
  `http://127.0.0.1:30000/worlds/izzy-campaign/data/campaign/ai-gm-protocol.md`.
  The response was **200**, `text/markdown; charset=utf-8`, content length 11214.
  The response body was not requested or logged. This demonstrates that session
  authentication does not protect this existing campaign route; it is not a
  complete external-network exposure audit.
- Current non-secret options inspected: port 30000, empty route prefix, no proxy
  port, `proxySSL: false`, configured user-data root `C:/dev/FoundryVtt/Data`.
- `WorldCampaignContext` derives the campaign directory from server-configured
  worlds root plus live-authorized world identifier. Current retrieval requires
  the folder to exist, reads bounded Markdown, caches file fingerprints, and
  applies resolver/presenter visibility. These authorization checks do not affect
  Foundry's independent static-file route.
- Current Python ChatKit agent has six fixed tool wrappers and no trusted catalog
  discovery wrapper. Current retrieval gives a campaign-state section ranking
  preference but no dedicated guaranteed overview budget. Current snapshot loads
  the first four scene actors rather than selecting the actual player/party.

## Proposed supported deployment boundary

Retain plaintext authored Markdown under the requested active world's
`data/campaign` directory. Put Foundry behind a supported reverse proxy and deny
**all** direct HTTP methods for every world's `data/campaign` subtree at that
boundary. Access campaign text only through the existing authenticated companion
adapter, with its world/user authorization and bounded visibility filtering.

Foundry documents [Nginx reverse-proxy deployment](https://foundryvtt.com/article/nginx/)
and [application proxy configuration](https://foundryvtt.com/article/configuration/).
The campaign-specific deny policy is an operator-defined reverse-proxy policy,
not a claimed built-in Foundry permission setting. No documented configuration
switch was found that makes ordinary Data Markdown session-private.

This proposal is effective only if clients cannot bypass the proxy to reach the
Foundry backend. The operator must approve and configure the backend access
restriction, including LAN/IPv4/IPv6 access and the local browser arrangement.
A firewall that restricts external access alone leaves direct loopback access
available to browsers on this host; that residual must be explicitly assessed.
Proxy flags alone are not access restrictions. Do not claim privacy while the
currently verified loopback route still returns campaign content.

Before applying any change, review the actual proxy and firewall configuration,
choose the client-facing origin, and account for current browser and companion
origin settings. Use a path-normalization policy that fails closed for encoded
separators, malformed encoding, duplicate separators, case variants on Windows,
dot segments, and any route prefix. Deny resources, draft proposals, transaction
staging, backups, and receipts throughout the campaign subtree. Do not put private
artifacts in separately served export locations. Existing campaign assets referenced
directly by Foundry may require an explicitly reviewed public asset location;
do not silently relocate them.

Required approval: security-sensitive proxy/server/network configuration and any
necessary reload, firewall rule, new origin, or persistent credential. A private
storage mechanism such as authenticated encryption is a separate possible design
but would alter plaintext compatibility and require an approved key-management
plan; it is not implemented or proposed as an unnoticed fallback.

File Picker visibility, filename obscurity, dot-directory names, a database-like
extension, and companion authentication alone are not acceptable privacy controls.
Do not patch vendor Express internals to insert undocumented middleware.

## Acceptance gates after approved configuration

1. In an isolated test world, create an approved harmless canary under campaign.
2. Verify unauthenticated and authenticated player/GM HTTP requests cannot read it
   through the proxy or directly through any reachable backend address. Verify
   GET, HEAD, range requests, route-prefix paths, encoded/case variants, IPv4,
   IPv6, LAN, and local-browser backend access. Log statuses only.
3. Verify the authenticated adapter returns only authorized bounded canary content
   and rejects revoked/cross-world sessions. Verify private/presenter filtering.
4. Verify assets and normal Foundry WebSocket use remain functional and that the
   approved protection survives restart. Inspect temporary and recovery filenames
   too. A mocked route test does not replace this live gate.

Until these gates pass, tests may validate storage safety in temporary directories,
but live private campaign authoring must remain unavailable. Preserve the existing
Izzy campaign; this proposal is not a migration authorization.
