# Combined offline release gate

2026-10-04 UTC. Both repair integrations pass combined offline validation. No runtime restart, model request, publication replay, native mutation, or UI change occurred during this gate.

- Aggregate Node tests: 557 passed (7 bootstrap, 9 shared, 449 server, 92 module).
- Aggregate Python tests: 183 passed in 199.108 seconds. A nonfatal SQLite connection ResourceWarning appeared during teardown; no test failed.
- Full workspace typechecks, shared/server/module build, and manifest synchronization check passed.
- Independent postbuild validation: 16 compiled TypeScript and 16 Python tests passed. These overlap aggregate coverage, not additional unique tests. See prompt1-prompt2-combined-independent.md.

The exact receipt-only grammar, authenticated gateway binding, one-call durable receipt finalization, compound-request rejection, cancellation, paired history/reconnect continuity, postcommit publication outcome classification, unforgeable commitment metadata, historical status authorization, context admission and privacy boundaries were validated with offline fixtures. Admission retains all 30 typed tools; fixture input is 19,154 conservative units against a 24,576 ceiling with 8,192 reserve. This fit does not guarantee every campaign will fit. No inference occurs in admission/preparation.

Disk identity is recorded in prompt1-prompt2-combined-disk-identity.json. Its SHA-256 hashes are calculated from locale-sorted artifact key/value entries serialized as JSON:

- AI: 75 artifacts, zero missing; a3d145a2939d52988a864fd07bbf94cf7b824c385527e63ddd324712137b2303.
- MCP: 17 artifacts, zero missing; 89c6101d903e5f4c2f8bcd5298f2bccb754b8878a09180c4bb47e4097079ca55.
- Python app.py: 6852e82f433891f5045422c4eb0e0c089e60211c9e0105823555f61f82c09530.

The independent report's manifest digest uses its own serialization; compare per-artifact maps rather than unlike digest conventions. Running AI remains the older 16:19:37.666Z startup with 74 artifacts; seven source/build paths differ or are newly absent. Python loaded digest remains aa5f5bf46ab1c1149d767fda29ef8d5fec3b20e27dd38086e9b80cfb2f271897, normal maxModelTurns 15. MCP loaded hashes match its disk. Deployment is pending; these results do not establish loaded repair behavior or broad player acceptance. Anonymous normal/encoded campaign overview requests returned 404 on the existing runtime.

Read-only production before/after snapshots retain 27 threads, 130 items, one consumed acceptance allowance, three cold fixture items and zero unused prepared fixture items. Evidence is protected under .runtime/foundry-ai-dungeon-master/combined-validation-production-{before,after}.json. Count equality is not a byte-level comparison of every production record. Completed publication prompt2-full-v5-confirmed-20261004 remains historical evidence and was not replayed.

Logs: prompt1-prompt2-combined-{node-tests,python-tests,typecheck,build,manifest}.log. No checks failed. Live deployment, loaded identity/authenticated historical status, one-call receipt regression and actual player/TV/manual acceptance were not run. The approved earlier allowance is exhausted/revoked and its unused slot is not permission to resume.

Next action requires explicit parent/user deployment authorization under visible-terminal/manual shutdown rules, followed by fresh loaded hash and authenticated readiness verification. The separately bounded proposal is prompt1-one-call-regression-proposal-20261004.md. Keep broader rollout and unsupported workflow machinery paused.
