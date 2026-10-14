# Phase 5 model-free live acceptance plan

Prerequisites: user confirms a connected, explicitly opted-in non-GM test client; verify its exact user/client/world identity and actor ownership. Build and independently validate scoped changes, request a manual restart if server code changes, and verify loaded artifacts. Inspect the existing targeted reload tool schema before refreshing only the intended client.

Inference budget: zero. No natural-language model prompts, provider changes or automatic-event setting changes.

Use the existing disposable vision scene only after confirming it remains a dedicated fixture. Read and save fresh active scene, pause state, viewed scene on each test client, token position/elevation/vision settings, fixture actor ownership, wall/door states, light settings and relevant fog state. If any field cannot be safely restored through supported APIs, omit that mutation and mark its case blocked. Never reuse historical original values as current originals.

Observe the player browser and independently request bounded structured perception for the same exact selected owned token. Compare these separately for closed/open doors, normal legal movement, basic local/global/dark lighting and visible versus hidden entities. Add elevation, selected-token mismatch, multiple sources and installed supported vision modes only where reversible supported fixtures permit. Mark unsupported or untested modes explicitly; visibility does not establish a legal path. Native movement/perception updates require no inference.

Read-only negative checks: disconnected/wrong client or token, unavailable/stale readiness, hidden field redaction and no GM fallback. Simulated disconnect/revocation/world drift are offline tests unless a specifically reversible live case is needed; do not alter another user's access or session.

Record exact identifiers, loaded hashes, authoritative outcomes, browser observations and structured reports separately. Browser sampling provides observation bounds, not native event timestamps. Restore every changed fixture value and original viewed/active scene/pause state. Verify readback and report any unrestorable state to the user; never restart or terminate services during cleanup.

Gates: independent offline correctness PASS; loaded identity PASS; browser rendering and structured projection each PASS/FAIL/BLOCKED. Player-facing model narration remains a separate untested gate without an approved inference budget and a proven player-scoped context boundary.
