# Private single-user dot composition

The ordinary CLI starts with dot disabled. With the AI Dungeon Master extension explicitly loaded, the companion reserves a fail-closed `/dot/mcp` route returning 503 until a scoped runtime is explicitly published. Setting `FOUNDRY_DOT_CONFIG` to an absolute config-file path opts into the production loader. No dot credentials, directories, ACLs, tunnel files, or subscriptions are created by the loader. An explicit disabled file contains only `{"version":1,"enabled":false}`.

This composition maps one dedicated local credential to one configured principal and one Foundry GM controller. The trusted local tunnel client injects the credential into requests to loopback `/dot/mcp`. Every cloud user allowed to call that tunnel target would acquire that same authority, so the workspace and tunnel target must be restricted to the intended single user. This composition is unsuitable for a shared or public plugin.

## Configuration contract

An enabled JSON config has exactly these fields:

| Field | Value |
| --- | --- |
| `version` | `1` |
| `enabled` | `true` |
| `mode` | `private-tunnel-single-user` |
| `owner` | One operator-selected principal identifier |
| `controller` | Exact `worldId`, `sceneId`, `clientId`, and `userId` |
| `privateDirectory` | Absolute, pre-provisioned private Windows directory containing the config |
| `credentialSha256` | Lowercase SHA-256 hex digest of a separate dedicated local credential |

[dot-config.example.json](../server/dot-config.example.json) is a valid disabled template. For later approved provisioning, this enabled template shows every required field; replace the angle-bracket placeholders before use. The hash placeholder intentionally fails validation.

```json
{
  "version": 1,
  "enabled": true,
  "mode": "private-tunnel-single-user",
  "owner": "<principal-id>",
  "controller": {
    "worldId": "<world-id>",
    "sceneId": "<scene-id>",
    "clientId": "<stable-browser-client-id>",
    "userId": "<foundry-gm-user-id>"
  },
  "privateDirectory": "C:\\<private-directory>",
  "credentialSha256": "<sha256-of-dedicated-credential>"
}
```

The dedicated credential must have the format `fdot_` followed by 43 base64url characters. Provision it separately under operator approval; do not reuse the administrative API key, tunnel control-plane credential, or webhook signing key. The server config contains its hash. The tunnel receives the raw credential through a protected environment variable or protected file reference, never model tool arguments.

The server must bind explicitly to `127.0.0.1`, `::1`, or `localhost`. Authentication accepts only POST requests to `/dot/mcp` from a literal loopback socket peer with one `x-foundry-dot-key` header. Forwarded address and identity headers confer no authority. Missing, wrong, duplicate, or revoked credentials fail closed. Changing the config file or its protected ACL revokes activation until a reviewed restart.

The [official tunnel configuration](https://github.com/openai/tunnel-client/blob/v0.0.16/docs/configuration.md) supports `mcp.extra_headers` and discovery/probe headers using `env:` or `file:` references. Configure this header only for the scoped dot target. The administrative MCP target must remain separate. Use the same dedicated header reference where authenticated discovery probes need it; never paste the secret as a literal YAML value.

## Foundry module configuration

After the approved private directory exists, a connected local GM can open **Settings → Game Settings → AI Dungeon Master → Configure tunnel**, or **Settings → Tunnel configuration**. In Game Settings, search for **OpenAI**, **dot**, **tunnel**, or **runtime key** to find the **OpenAI dot tunnel configuration** entry. The same screen shows the official tool installer, tunnel ID, verified current GM/controller scope, and a masked, write-only OpenAI tunnel runtime-key field. No credential is a Foundry setting. Key fields start empty; **Runtime key: Configured** confirms a saved file rather than showing the secret. Leave the key blank to preserve it. Replacing a saved key requires both the replacement checkbox and a second confirmation.

Only the independently verified local GM connection in `mcp-test` may save. The companion obtains the current world, scene, user and browser client from that exact connection and checks it again before writing; the browser cannot choose another controller. Credentials travel only over the existing loopback `/bridge` connection using an exclusive configuration message consumed before general bridge listeners. They never enter the event bus, persistent outbox, request audits or latency traces. Input is cleared before submission and on dismissal. There are no automatic retries of a key submission; after an uncertain result, refresh status before entering another key.

**Save configuration** writes the dedicated bridge credential, its hashed server configuration, the runtime-key file and a profile with file references inside the pre-provisioned owner-only directory. It does not create Platform credentials, start a tunnel, change environment variables, enable dot mode or subscribe. Unknown files, other controller scopes and retained event stores are refused for reviewed recovery. **Activate** is available only when the server verifies the saved profile, dedicated key, private Windows permissions, absence of recovery locks, exact current GM/browser/scene, automatic AI DM events in `dot` mode, and pinned installed tool bundle. The previously reported administrative-key exposure remains an independent operator concern; activation neither claims it was rotated nor reuses that key. Its accepted risk does not weaken the dedicated dot authentication or broaden the fixed upstream. The earlier PowerShell key-entry helper is an operator fallback, not the normal configuration workflow.

Save displays progress while Windows permissions are verified and waits up to six minutes for a confirmed result; status reads wait up to three minutes. A confirmed success explicitly reports the stored key/configuration and that activation requires a separate confirmation. Failures use fixed, whitelisted reasons for input, key replacement, scope, profile, private storage, or interrupted persistence; raw errors and key values are never rendered. Save also includes the displayed controller as a concurrency check; a scene/user/client change requires Refresh status and a new deliberate Save. An interrupted file mutation retains a nonsecret `configuration.lock` marker, cleans only its own temporary files, and refuses status success, further saves and production activation. Preserve the marker and existing files for operator reconciliation; never delete it automatically, retry a secret submission blindly or restore secret-bearing backups. Installer controls remain available when private configuration is unavailable.

## Explicit activation lifecycle

Activation needs a separate confirmation and rechecks the displayed controller before binding and again before launching. It runs the official pinned client with `run --profile-file` and file references in the existing visible Windows console. It creates no service, persistent alias, startup entry or background daemon. A host requires a visible console and assigns the suspended official client to a kill-on-close Windows Job before resuming; only NUL handles reach the child. Raw client output is discarded. The child receives a minimal Windows environment with no administrative credential, proxy, alternate profile or unsafe HTTP logging overrides.

**Refresh status** reports bounded nonsecret process phase, local health and local readiness. The host probes only the fixed loopback health listener after verifying its owned child is listening there, disables redirects/proxies and discards response bodies. A running process or local readiness does not establish a ChatGPT connection, a subscription or event delivery. No subscription is created by activation.

Each explicit activation creates a diagnostic attempt ID. Configure shows the last ID, fixed failure phase/code, and whether a report was saved. Saved reports are at `%LOCALAPPDATA%\FoundryDot\diagnostic-<attempt-ID>.json`, in the existing protected AI-owned folder outside world data. Reports contain generated timestamps, stage durations, validation booleans, owned process IDs, bounded exit codes, fixed failure codes and local health/readiness transitions. They contain no keys, headers, credential hashes, configuration values, raw process output, arbitrary error text or world/user identifiers. Remote connection and delivery are not inferred from local readiness.

Diagnostic IO runs asynchronously and cannot prevent route revocation or owned-process cleanup. Each record is flushed and atomically replaced; an interrupted attempt remains marked `in_progress`. Retention is bounded to sixteen files (including temporary files), 32 KiB per file and 64 events per record, with a dropped-event count. Only verified diagnostic files with the exact generated name/schema are rotated; unknown or malformed files are preserved and logging becomes unavailable. A crash-only temporary record is preserved but is not reported as a saved final JSON file. No directory or permission repair is automatic. If saving fails, Configure shows the ID with **unavailable**, rather than claiming evidence was saved. A separately authorized deployment/restart is required to load these source changes; they do not retry activation.

**Stop** needs separate confirmation and stops only this in-memory owner's host/job. It immediately removes the dot route's runtime, aborts pending responses and webhook delivery, unbinds the producer and preserves durable subscriptions/events for the same scope. A failed or unconfirmed child shutdown keeps ownership and refuses another launch. Disconnect, prerequisite changes, child death or companion shutdown also revoke the endpoint and stop the owned tree. Stale status/watchdog/exit callbacks cannot stop a replacement runtime. A companion shutdown prevents a pending activation from launching afterward.

Externally supplied `FOUNDRY_DOT_CONFIG` composition remains supported; the settings lifecycle refuses to claim or replace it. Stopping that external composition uses its supported launcher. No environment reload or companion restart occurs in the settings workflow.

## Protected persistence requirements

The directory and files must be owned by the server's Windows user. The directory must have a protected DACL whose allow entries are solely that user; files may inherit that private DACL. Reparse points in the directory, its ancestors, or target files are refused. The verifier only reads permissions. The event store is `dot-events.json` inside this directory and uses bounded durable writes.

Webhook secrets use Windows DPAPI `CurrentUser` with a fixed dot-specific entropy value and a versioned ciphertext prefix. Failure to protect or unprotect a secret refuses the operation. There is no plaintext fallback. Moving the store to another Windows account requires reviewed recovery rather than copying plaintext keys.

## App-managed tunnel tool installation and updates

After deploying this source through the supported build/launcher, the connected GM can open **Settings → Tunnel tool setup**, or AI Dungeon Master's module API `dotTunnelSetup.show()`. Opening/rendering settings does not download anything. Setup shows the required and installed versions, platform, retained prior version and errors. Downloads are disabled on each companion start and GM disconnect. Select **Enable downloads for this session**, then **Install required version**, and confirm. The independently verified GM bridge checks the exact world, user and client; no administrative key, download URL, output path or version is supplied by the browser. One GM owns each enabled setup session.

This app release pins official OpenAI `v0.0.16` for Windows x64/arm64 in [tunnel-release.ts](../server/src/dot-integration/tunnel-release.ts), using the [published release hashes](https://github.com/openai/tunnel-client/releases/expanded_assets/v0.0.16). It retains the complete seven-file bundle, including the pinned cloudflared companion, licenses, notices and SPDX inventory. Download is HTTPS only, allows one official GitHub asset redirect, rejects private DNS addresses, and has fixed byte/time bounds. Archive SHA-256 and the pinned SPDX checksum plus each payload digest are verified. Installation never executes the binaries or changes permissions, environment, startup services, credentials, tunnel configuration or subscriptions.

AI Dungeon Master owns new installs in `foundry-ai-dungeon-master/.runtime/tools/openai-tunnel-client/` and verifies/adopts existing `foundry-local-api/.runtime/tools/openai-tunnel-client/` receipts in place, with immutable version directories and an atomically selected `current.json`. Installation refuses links, junctions, hard-linked files, unexpected archive paths/members and unsafe storage. Failed download, verification, cancellation or update preserves the prior selection. An exclusive lock serializes installation across companion processes; a foreign/stale lock is preserved for operator inspection. Partial staging cleanup affects only the current attempt's checked app-owned paths.

Future integration releases update the required static pin and retain reviewed prior manifests in `REVIEWED_TUNNEL_RELEASES`. The GM then explicitly installs that release's required version in the same setup dialog. There is no auto-latest lookup or silent in-game update. Updates retain the previous directory and descriptor. **Restore verified prior version** is available only when that descriptor matches a reviewed manifest for this platform and every retained file still verifies; rollback is offline, explicitly confirmed, and atomically changes selection. This initial release includes no reviewed older manifest, so a preexisting unknown version can be retained but cannot be offered as verified rollback. Maintainers should retain the old reviewed manifest when advancing the pin.

After update/rollback, persistent status says to restart any existing tunnel through its supported launcher to use the selected bundle. Setup does not inspect running processes, restart a tunnel, or clear that reminder based on an unverified process claim. First-time installation still requires separate tunnel credentials, access configuration and activation. Real download, live Foundry dialog operation and active tunnel upgrade remain operator acceptance checks; automated verification uses synthetic archives and downloads.

## Controller and response behavior

The gateway exposes a copy of the independently verified Foundry world/user/GM identity for the current live connection. Production binding requires that identity to match the exact configured world and GM, plus the configured browser client and active scene. The browser must enable automatic events and select AI DM mode `dot`. Its default mode remains `embedded`; the producer emits exclusively through the selected mode.

The authenticated catalog exposes three tools. Call `foundry_dot_get_scope` with `{}` to obtain only `worldId`, `sessionId`, and `controllerId`; use that result as the arguments to `events/subscribe` for the event returned by `events/list`. This bootstrap requires the configured principal and currently verified controller and rejects caller-supplied scope selectors. It reveals no browser user/client identity, credential, callback or unrelated scope.

`foundry_dot_read_turn` and `foundry_dot_respond` are scoped through a retained event ID; arbitrary world, scene, combat, or document IDs are rejected. New responses require a current state revision and create one deterministic ChatMessage. Repeated identical calls reconcile that document. An uncertain result requires retrying identical arguments; a changed response is rejected. Canceling queued execution prevents a later write. Once a native write starts, its outcome must be reconciled.

## Restart and recovery

Scope IDs derive from the durable store generation and the exact configured principal, world, scene, GM user and browser client. A restart with the same private store and configuration resumes the same IDs after independently verifying the live Foundry identity and browser binding again. Normal shutdown pauses delivery and preserves queued subscriptions, retained events, cursor generation and response reconciliation. Unsubscribe is the explicit durable subscription stop. Delivery resumes only while the controller is active; expired subscriptions and bounded retries retain their existing behavior. The scheduler waits for a pass to finish before scheduling its next pass, so a stalled callback cannot build an unbounded dispatch backlog.

Changing the configured controller/principal while retained work exists refuses activation with `scope_recovery_required` and does not alter the store. Restoring the original configuration permits reviewed same-scope recovery. A store written by an earlier prototype with random scope IDs likewise refuses automatic activation. Preserve that store and the original browser receipt ledger; do not delete them, rewrite IDs, or regenerate an event to bypass reconciliation. An operator must review every unfinished delivery and uncertain Foundry response against its existing event ID and deterministic message before explicitly retiring the old scope and provisioning a fresh store. Automatic migration of unverified legacy identity is unavailable.

Event delivery follows [MCP Events](https://developers.openai.com/plugins/build/mcp-events): stable event IDs, scoped cursors, durable bounded queues, signed public HTTPS callbacks, and bounded retries. A callback 2xx acknowledges receipt; it does not confirm that the DM response was completed. The transport implementation and contract are described in [dot-mcp-events.md](dot-mcp-events.md).

## Deferred operator acceptance

Source and synthetic tests do not activate this integration. Operator acceptance still needs separately authorized deployment/restart, explicit app-managed tool installation, credential provisioning, private storage setup, tunnel configuration/activation, and a single private-session end-to-end trial. Check discovery and subscription denial without the dedicated key, exact controller binding, one player-turn webhook, fresh scoped state, one response document, duplicate reconciliation, mode-switch revocation, and disconnect revocation before wider use.

