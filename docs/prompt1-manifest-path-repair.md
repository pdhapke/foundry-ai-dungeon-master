# Privacy manifest path repair — disk only

Corrected server/src/build-identity.ts from the nonexistent `server/dist/context/campaign-privacy.js` to the actual `server/dist/campaign-privacy.js`. No privacy authorization or missing-hash policy changed. Missing files continue to be represented as explicit null hashes; startup snapshots remain immutable after disk edits.

Server build and three focused manifest/HTTP tests pass. New regression verifies actual privacy bytes hash correctly, the incorrect key is absent, missing privacy remains null, and an earlier missing snapshot is not rewritten. Direct compiled disk inventory contains 53 entries with zero missing hashes and the privacy hash matches its actual bytes.

Fresh live health still reports the original startup at 2026-10-04T00:13:36.274Z, the wrong privacy key as null, and no correct key. The disk-only result does not close the live instrumentation gap. Exact comparison is recorded in prompt1-manifest-path-loaded-vs-disk.json. Build refresh did not restart the stack or alter its frozen manifest. Existing substantive privacy implementation was not changed by this repair.

Full runtime evidence requires another Peter-confirmed manual stop, fresh process/listener/lock check, then supervised existing-alias foreground startup in a verified visible desktop terminal. Batch this instrumentation deployment with any other required deployment steps identified before that restart, then compare the new live manifest (including a non-null correct privacy path) with disk, recheck anonymous denial, and perform authenticated GM/UI/isolation acceptance. No automatic restart or weakening of the gate is authorized.

GM reconnect confirmation is pending from the parent; no dependent authenticated check was attempted. No inference, usage allowance, unrelated source changes, service starts/stops, new access or permission changes occurred.
