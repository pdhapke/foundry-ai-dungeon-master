# Independent startup-manifest privacy-path validation

2026-10-04 UTC. Narrow offline validation plus read-only live health; no restart, authentication request, inference or runtime configuration change.

Independent rerun of node --import tsx --test server/src/build-identity.test.ts passed 2/2 tests. Coverage verifies startup hashes remain unchanged after later disk edits; missing artifacts remain explicitly null; the compiled privacy module's correct key server/dist/campaign-privacy.js hashes its actual bytes; the obsolete server/dist/context/campaign-privacy.js key is absent; publication of the present artifact changes the digest without altering the previously captured missing snapshot. These are two independent test cases, not three.

Direct capture from the current built module root contains 53 entries, all non-null. The correct privacy entry matches independent SHA-256 of its actual compiled file, and the obsolete key is absent.

The running AI health still reports startup 2026-10-04T00:13:36.274Z and the prior 53-entry manifest: obsolete privacy key null, correct key absent. Its manifest digest differs from the newly captured disk manifest. This is expected immutable startup evidence, not loaded verification of the fix. A manually supervised shutdown/restart through the existing visible-terminal alias is required before health can attest the corrected privacy artifact. Do not claim a source/build check proves this patch is loaded. No restart was performed and no GM-authenticated checks were attempted in this task.
