# Exact private-data migration approval gate

Code and fixtures are ready; source cutover is not approved or performed. No runtime restart or OS/security-permission change occurred. Do not advance on a private-copy-only result.

## Current inspected exposure

An unauthenticated Range request for the existing `worlds/izzy-campaign/data/campaign/secrets-tracker.md` returns206text/markdown. Body content was neither printed nor included in reports. The installed internal retrieval route denies unauthenticated requests403; its protection does not extend to Foundry's static original URL. New application routes do not mount the protected filesystem. Current runtime is the old implementation; fresh-source tests prove new retrieval gates, not loaded deployment.

The legacy source tree contains168non-media files,1,112,446bytes:135Markdown,25JSON,4MJS,3PY,1PYC. Eighty-six image/video assets are excluded from copying so current scene/token URLs stay usable. Private source names and exact revisions are recorded only in the nonserved manifest, not this report. Retained media remain a separate disclosure/annotation audit, not proof of broad campaign secrecy.

Node's operational database also persists campaign proposal before/proposed text. Its current default is beneath the module's public Data tree. Although observed hidden SQLite URLs returned404, the new guard requires storage outside that tree rather than relying on filenames. New private Markdown alone does not satisfy this prerequisite.

## Completed reversible preparation

A copy-only candidate of all168files exists at:

`C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/campaign-worlds/izzy-campaign/data/campaign`

The source was rehashed before/after copying; no original was removed, overwritten or used to restart the application. Copy verification passed with manifest revision:

`5a240800d4ffb364b332ca505e0e7f2fd447990362a44dc26423f7eb920d64c7`

The exact scope is the files listed in these private manifests:

- `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/campaign-worlds/izzy-campaign-source-review.json`
- Candidate `.migration-manifest.json` under the directory above.

Aggregate evidence: `docs/prompt1-private-migration-plan.json`. This is copying, not a source relocation or completed privacy remediation. Candidate scripts were copied as bytes and never executed. Cancellation/source conflict retains a lock and withholds all partial reads; recovery requires operator review, not automatic deletion or merging.

## Approval requested for consequential cutover

The parent must obtain explicit permission for this exact plan before moving source data or changing deployment configuration:

1. **Public authored copies:** relocate exactly the168manifested originals under `C:/dev/FoundryVtt/Data/Data/worlds/izzy-campaign/data/campaign` to a timestamped archive outside Foundry Data, e.g. `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/campaign-archives/<approved-timestamp>/izzy-campaign`. Preserve hierarchy and every byte; do not delete original data. Recheck the entire source/candidate manifest first and refuse if changed. Retire only emptied nonasset directory entries after files have been preserved. Leave the86public image/video files at their existing URLs. Unknown files, symlinks, receipts, JSON/scripts, SVG or unexpected directories remain blocked until reviewed. No arbitrary wildcard deletion is approved.
2. **Operational/auth/history store:** after Peter's separate manual shutdown approval/confirmation, preserve and relocate the complete `C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master/.runtime/ai-dungeon-master` tree, including `operations.sqlite`, its WAL/SHM, existing backups, encrypted provider state, legacy `chatkit.sqlite` and trace files. Proposed destination: `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master-node/ai-dungeon-master`. Inventory/hash every file privately first; do not print credentials, encrypted token bodies, history or proposals. Capture consistent SQLite backups and verify integrity/row counts while stopped. Retain a second verified archive outside Data; do not alter encryption keys or authorize a new sign-in.
3. **Configuration:** set only `AI_DM_RUNTIME_ROOT=C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master-node` in the existing supported server configuration, preserving all other values. This keeps the existing Node store/credential owner, rather than opening a new empty competing store. The relocated legacy ChatKit database remains discoverable for the already-implemented migration to `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/chatkit.sqlite`. The protected campaign root is already defaulted beside that private database. Fixture allowance remains empty; no inference permission follows from migration approval.
4. **Verification:** before any model request, verify protected copies and source hashes, absent original authored URLs (404/denial, including Range/encoded-path cases), fresh GM authenticated access and other-user/world/anonymous denial. Verify proposals/receipts/threads/provider state survived without replay, ordinary15limit unchanged, startup hashes/configuration and actual panel privacy transitions. Operational store and protected root must be outside real public Data roots including junction resolution. Media disclosure/labels need separate review. No live privacy claim until loaded checks pass.

No source relocation, operational-store migration, configuration edit, shutdown or restart was executed in this continuation. Future startup must follow the existing visible-terminal/manual-stop rules and requires separate supervision.

## Reversibility and failure

Before cutover, originals and candidate are both retained. After approved relocation, the external archive keeps originals byte-for-byte; a manifest records each original/destination. If private cutover fails, keep the stack stopped, retain evidence and restore the previous configuration/files only with Peter's direction. Restoring public originals restores the privacy exposure and keeps the gate failed; it is not a successful secure rollback. Never overwrite newer canonical files or hot databases. If any inventory/hash/lease/integrity/static-denial test fails, stop and ask for the exact repair action rather than deleting, hiding or retrying blindly.
