# Approved private cutover result

The supervising parent relayed Peter's explicit migration approval and manual shutdown confirmation, then accepted preserving both SHM versions and refreshing only coordination-file inventory. That disposition did not authorize substantive drift, deletion, new access, inference, or rollback to public exposure. Attribution of the 12 changed SHM bytes remains unproven.

Fresh primary and independent escalated shutdown checks found no conflicting stack processes, listeners or active Data/Config/options.json.lock. All six substantive operational files, including database and WAL, remained identical. Both SHM versions and their original/refreshed manifests and disposition are retained privately in `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/cutover-backups/20261004T000540Z`. Three consistent SQLite backups were rechecked via private immutable connections; integrity and all recorded table counts passed without reopening source databases.

## Preserved relocation

- Exactly 168 approved originals moved to `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/campaign-archives/20261004T000540Z/izzy-campaign`, preserving hierarchy, hashes and bytes. The protected working copy remains at `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/campaign-worlds/izzy-campaign/data/campaign`. Both independently match approved revision `5a240800d4ffb364b332ca505e0e7f2fd447990362a44dc26423f7eb920d64c7`.
- All seven operational files moved from the old public module runtime tree to `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master-node/ai-dungeon-master`; independent pre-start hashes match reconciled inventory. A separate verified original archive and consistent SQLite backups remain outside Data.
- Only `AI_DM_RUNTIME_ROOT=C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master-node` was added to existing server/.env; prior configuration and provider encryption keys were retained. The prior env file is privately archived.
- 86 existing public media remain at original paths. Only 26 empty nonasset directories were retired with nonrecursive checked-root removal. No file deletion, security-permission change, new sign-in, or public rollback occurred. Loaded media were not comprehensively reviewed for annotations/disclosure.
- After relocation, bounded legacy inspection reports ready=true, sourceCopies=0, publicAssets=86, unsafeArtifacts=0. Server build passed.

## Visible startup and live evidence

The alias definition was inspected in Peter's `.bashrc`, sourced by `.bash_profile`: existing node App/main.js with established Data path. After one more shutdown check, it was invoked through Git Bash in a normal visible mintty window with foreground output and hold-always behavior. Actual owning mintty PID13540/window2162952 was independently identified by Win32 enumeration, IsWindowVisible=true. Terminal title is `Foundry approved private cutover`; only this terminal's screenshot was captured privately and visually inspected to confirm foreground logs. Initial launcher PID46636 delegates to this owning mintty. The terminal remains available; no service was separately started or killed.

Fresh MCP startup 2026-10-04T00:13:35.817Z; AI startup 00:13:36.274Z. MCP/AI/Python health responses are ready. Independent comparison verified all 15 non-null MCP and 52 non-null AI startup hashes against disk; Python app digest matches and maxModelTurns=15. One manifest entry incorrectly names `server/dist/context/campaign-privacy.js` while its actual path is `server/dist/campaign-privacy.js`, so its null hash is an instrumentation coverage gap, not loaded-byte proof for that individual module. No source-only check is counted as complete live privacy acceptance.

Independent live anonymous probes: seven plain/Range/encoded former campaign/operational paths return404; /chatkit/prepare returns401; /internal/chatkit/read returns403. Bodies/secrets were not printed. Encrypted provider-state hash was preserved. Read-only SQLite-to-in-memory online backups confirm all old operations rows (458 across38 tables) and legacy ChatKit rows (165 across4 tables) retained in actual private runtime storage with integrity checks passing. No hot file-copy verification or mutation replay was used.

## Remaining gates

Authenticated capability report currently lists no connected browser clients. Actual current-GM preparation/retrieval, other-user/world isolation and panel readiness UI have not been accepted live. They need Peter to reconnect the intended GM Foundry browser; no administrative key was substituted for browser identity. Player/TV enrollment renewal remains deferred. Prior manual perception acceptance remains narrowly the single deterministic Sargauth corridor sentence; it is not broad narration secrecy, encounter or TV acceptance.

Stage A actual scene/door/user/client/thread bindings remain pending supported current-GM fixture readiness; exact prompt template and limits are in prompt1-live-acceptance-proposal.md. No usage allowance was configured, no model request/summary/embedding/image request occurred, and Prompt2 or broader rollout did not start. Preserve the running visible terminal and do not restart or restore public data automatically. Remaining live provider output-cap acceptance requires its separately approved inference budget.

Supporting independent evidence: prompt1-cutover-independent.md. Earlier stopped report is historical and superseded by this approved reconciliation and cutover result.
