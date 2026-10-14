# Approved cutover stopped before mutation

Peter's approval and manual shutdown confirmation were relayed by the supervising parent. Read-only escalated process/listener checks found no conflicting Foundry stack, relevant listener, or active Data/Config/options.json.lock. Unrelated Codex and other project processes were preserved.

The 168 public authored originals and 168 private candidate files matched the approved SHA-256/size manifest, revision `5a240800d4ffb364b332ca505e0e7f2fd447990362a44dc26423f7eb920d64c7`. Fresh migration planning returned exactly 168 files, 86 excluded media, and no blockers. Independent inspection validated all 86 media signatures and paths.

Seven operational files were copied and SHA-256 verified in the private archive `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/cutover-backups/20261004T000540Z/operations-original`. Consistent backups of three SQLite databases were then captured through read-only source connections. Source and backup integrity checks passed and every table's row count matched; private details are saved beside the archive, without printing contents.

The final pre-move inventory guard stopped on `operations.sqlite-shm`: its length remains 32768 bytes, with 12 bytes changed since the raw archive. All six other operational hashes, including operations.sqlite and its WAL, remain unchanged. Read-only SQLite inspection can update shared-memory coordination state; this is a plausible cause, not independently proven attribution. The original raw archive retains the earlier SHM, and current source retains the later SHM. No source movement or configuration editing began: the guard failed before either operation.

All 254 original public campaign files remain, the operational source remains in its original location, the proposed operational destination is absent, and AI_DM_RUNTIME_ROOT has not been added. The stack was not started or stopped by this agent. No permissions, authentication, allowance or model settings were changed; inference requests zero.

The approved plan explicitly requires stopping for an inventory/hash failure. Required parent review/action: accept or reject preserving both SHM revisions, refreshing the operational inventory after the stopped SQLite backup inspection, then resuming the already-approved relocation if a fresh shutdown check and all persistent database/WAL/source hashes still match. Do not delete SHM/WAL, overwrite either archive, or restore public copies. Further database inspection should use private copies to avoid changing source coordination state.

Live loaded-runtime, authenticated access/isolation, static-denial, readiness/UI, visible startup and fixture-ID checks were not run. The old public authored exposure is not remediated. Alias investigation found Git Bash's existing foundry alias in C:/Users/peter/.bashrc; no launch was performed.
