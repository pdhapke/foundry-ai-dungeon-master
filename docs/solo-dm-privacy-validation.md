# Independent privacy prerequisite review — October 1, 2026

Direct-file privacy: **FAIL**. Protective deployment: **BLOCKED** pending approval and an enforceable backend-isolation design. This is not a full Phase 1 pass.

## Independently reproduced evidence

A new PowerShell HTTP client sent an unauthenticated HEAD request, without supplied cookies or authorization, to http://127.0.0.1:30000/worlds/izzy-campaign/data/campaign/ai-gm-protocol.md. It returned 200, text/markdown; charset=utf-8, Content-Length 11214. No body was requested or recorded. Inspection of installed App/dist/server/express.mjs confirms Data static middleware registration precedes sessions, and the static deny patterns do not include Markdown/campaign paths. Vendor code was not changed.

## Deployment proposal assessment

Foundry's [Nginx guidance](https://foundryvtt.com/article/nginx/) supports proxying HTTP and WebSockets and directs operators to change access-control rules. Its [configuration guidance](https://foundryvtt.com/article/configuration/) documents proxy-related settings. Neither is evidence that proxy flags make the Data route private. The proposal correctly treats the campaign deny policy as operator configuration and requires prevention of direct backend access.

A proxy deny alone is insufficient on this Windows host: the independently reproduced loopback URL bypasses it. Binding the backend to loopback or blocking LAN traffic would still allow local browsers to make direct requests. A feasible deployment must provide a separately enforced boundary (for example, an isolated backend network reachable by the proxy and companion only) and accommodate companion connectivity. Whether the current host can provide that boundary without disruptive changes remains unverified; do not assume a generic Windows firewall rule closes loopback access.

## Fail-closed requirements

Keep live private campaign authoring disabled until an approved deployment passes direct/proxy IPv4, IPv6, LAN and local-browser tests. Do not use startup configuration assertions alone as privacy proof. Deny the complete campaign subtree, including drafts, journals, recovery artifacts and receipts, after consistent path normalization; malformed/ambiguous paths must fail closed. Preserve referenced public assets until separately reviewed.

Filesystem containment and recovery tests can proceed in temporary directories and establish storage safety independently. They cannot repair this HTTP confidentiality failure. No network, config, credential, fixture, service, reload, world or vendor mutation was performed. Changed path: this report only. Required next step: operator-approved isolation/proxy design and live privacy gate; no privacy deployment claim is justified today.
