# Prompt 2/3 combined independent source gate

2026-10-04. Read-only implementation audit after `prompt2-resume-handoff.md` and `prompt2-resume-independent-gate.md`. Deployment, aggregate tests/builds and runtime identity remain root-owned. No runtime operation, model request, model switch, scene mutation, real asset import or campaign publication occurred here.

## Approval/auth/privacy integration

`server/src/index.ts` binds the agent preparation tool to `origin:'dm'` and the authenticated browser gateway to `origin:'browser'`; callers cannot choose the trusted origin inside request input. Gateway session proof, bound identity and current-GM authorization precede preparation operations. `PreparationService` checks private storage and world scope, repeats authorization around consequential browser operations, and returns untrusted source data with `narrationAllowed:false` and `modelCalls:0`.

Candidate confirmation/publication, native review/apply and public local-raster import explicitly reject DM origin. Publication binds candidate contents and companion/source/interview revisions to the exact reviewed digest. Native grants bind world/user/client, package digest and kind; the durable composer/transport rechecks job revision/cancellation, source identity, inactive scene identity and readback around bounded existing MCP calls. Public raster import is separately browser-approved; generic approval of campaign intent does not grant asset disclosure or native execution.

Prompt 3's generic action/receipt drawer reads the existing `/chatkit/actions` domains; it does not issue preparation human grants or call preparation publication/native apply. Its contextual reads do not approve anything. Campaign setup saves explicit out-of-character preferences through the separate preparation interview operation; this does not publish canon. Existing compact menu access preserves ordinary exact action approval/receipt recovery. A complete browser review UX for resumed preparation publication/native packages is not established by the generic action drawer.

Protected source/candidate/interview/job storage remains outside public Data. Source-copy/operational-store privacy checks fail readiness closed; allowed public images still need independent disclosure review. Missing selected-world canonical overview/index remains a documented review/publication dependency. Healthy socket/provider status or hidden Ready caption does not establish missing-canon, player/TV or native visual acceptance.

## Selected-model context independent rerun

Ran only `.venv/Scripts/python.exe -m unittest test_context_admission_independent -v`, with `AI_DM_CHATKIT_DATABASE_PATH=:memory:` set before import. **7/7 passed**; log `prompt3-combined-context-independent.log`. Test constructs the same real agent/schemas and mocks provider streaming; endpoint tests assert no Runner call.

Selected `gpt-5.6-sol` stays on the conservative 32768 window with 8192 reserve / **24576 input ceiling**, all **30** tools unchanged. Permanent conservative input **19154**, remaining **5422**; realistic complete paired-history fixture **22510**, remaining **2066**. Tool schema normalized baseline remains equal. Oversized required history and unresolved tool pairs fail closed; literal schema values/property names survive annotation compaction. No permanent preparation tool or enlarged model limit was introduced by resumed preparation operations. On-demand preparation results still consume request context and may be refused when combined state is too large.

## Pending acceptance

This is source/offline evidence only. Root must assess combined aggregate build/test logs and actual loaded artifact hashes after the visible-terminal deployment. Actual current-GM preparation, canonical review/publication, native inactive-scene readback, artwork/grid/TV measurements and rendered compact UI remain separate gates. No trusted browser/desktop tools are available to this validator. No screenshots, space measurements or visual acceptance are claimed.

## Combined aggregate/build identity review

Independently inspected root-produced logs under `C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/prompt3-combined-evidence`. AI: bootstrap 7/7, shared 9/9, server 431/431, module 92/92. MCP: bootstrap 18/18, shared 49/49, server 536/536, module 358/358. Python: 164 tests, OK. All reported suite failure counts are zero. These are overlapping aggregate counts, not unique test totals. AI complete workspace build and AI/MCP workspace typecheck logs are clean; MCP server identity-only rebuild log is clean. No repeat aggregate tests/builds were performed here.

The narrow MCP manifest change adds compiled world-document endpoint and shared world-document schema bytes. Read-only fresh compiled disk-snapshot check independently imported the identity modules (no server startup) and compared SHA-256 against those actual files: AI **74 artifacts, zero missing**; MCP **17 artifacts, zero missing**; both new world-document artifacts covered and byte hashes match. This fixes manifest coverage of the preparationGuard contract. Snapshot evidence establishes compiled disk coverage only, not the current service's loaded bytes; the diagnostic change does not modify handler execution.

Root's `runtime-identity.json` remains explicitly older runtime: AI startup 53 artifacts with mismatches against current disk, MCP older 15-entry manifest, Python loaded/disk digest mismatch, inferenceRequests 0. Canon overview/index are absent under the existing private root. Four named anonymous static probes returned 404 with bodies not read/printed; this is narrow URL evidence, not comprehensive secrecy acceptance. No opted-in current GM is connected per root; neither liveness nor build success establishes campaign/client prerequisites Ready. Required next acceptance remains the authorized visible-terminal restart, loaded identity readback and genuine GM/browser validation, without live inference or automatic publication.
