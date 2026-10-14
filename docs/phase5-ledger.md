# Phase 5 player perception ledger

Status: partial scoped live acceptance passed and fixtures restored. Schema-blocked cases and player-facing model narration remain open. No inference used or authorized.

## Ownership

- Orchestrator: ledger, runtime identity, reversible fixture plan and eventual browser acceptance. No service lifecycle actions.
- context: MCP shared scene-render contract, native scene-render command, server endpoint/output schema and focused tests.
- completion: AI server/shared/Python perception projection and focused tests. No frontend application edits.
- validator: independent tests and evidence only; no production edits or live mutations.

## Shared contract

Versioned request-local observation identifies world, scene, user, token, actor and exact client. Non-GM consent and ownership are rechecked. Readiness is ready, stale or unavailable. Native pending render flags provide limited request-local evidence, not a global freshness epoch. Missing readiness and changed identity/state must not yield confident visibility claims. Server checks the exact client connection before and after retrieval. No mutable cross-turn cache or GM visibility fallback. AI projection must allowlist fields and exclude raw unrestricted context/issues.

## Evidence and gates

- Baseline independent evidence: phase5-independent-baseline.md/json and inventory files.
- Runtime readiness: phase5-client-readiness.json. Only GM connected at initial inspection.
- User reports Izzy logged into Chrome incognito; read-only user listing confirms active non-GM Izzy (edtBL96Yu3058QAT). Bridge still has only GM; player consent/save/reload requested. Incognito is absent from browser automation inventory.
- Subsequently user confirmed consent and incognito extension enabled. Supported short-lived one-time enrollment was accepted; capability report verifies player client 80f7f865-6ebf-4a83-ad44-33ab0c0747f2 for Izzy, optedIn true/isGM false/player lane. Browser tab 1958919419 (Chrome connection 4) visibly identifies Izzy; unrelated GM tab preserved. Evidence: phase5-izzy-enrollment.json and phase5-connected-clients.json. No credential was exposed.
- Existing disposable actor ownership grants TV and GM only. Use a new disposable Izzy-owned fixture rather than changing campaign ownership.
- AI worker found production read-tool metadata omitted token visibility; narrow bounded read descriptor integration is in scope, with dispatch and revocation tests.
- Historical basic vision tests are historical evidence; they do not establish current structured reporting, elevation or every vision mode.
- Latest user-managed restart verified normal response request limit 15. This is a per-response model-request ceiling, not combat rounds or conversation reset.
- Offline implementation gate: PASS. Independent 35 MCP and 23 overlapping dependent tests/typechecks pass; three review defects repaired/revalidated. Full MCP native337/server529, AI server292 and Python95 pass; affected builds/typechecks pass. See phase5-independent-offline-gate.md and worker reports.
- Loaded artifact gate: PASS after user-managed restart. Root and independent validator match all 50 startup/disk artifacts, Python code and limit15. Exact Izzy and GM receiver acknowledgements match native marker215f9274; no client reload necessary. Evidence phase5-loaded-verification.json, phase5-independent-loaded-verification.json, phase5-native-readiness-verified.json.
- Live structured reporting/browser gate: PASS for tested selected-player door/movement/light/fog/basic/darkvision/hidden-entity/elevation-Region subset; no GM substitute. Secret-door and multiple-source cases BLOCKED by schema validation; narration privacy/additional modes unaccepted. See phase5-handoff.md.
- Player-facing model narration privacy: unproven by prompt warnings; separate from model-free structured reporting.

## Next step

Final disk manifest captured in phase5-prepared-build.json; this is not loaded runtime evidence. Manual Foundry restart required to load Node/Python changes. Then run phase5-verify-loaded.mjs, verify exact native receiver build after targeted client refresh, reconnect/re-enroll only opted-in Izzy if needed, and execute model-free reversible acceptance plan.

Finish scoped implementation and independent offline validation while awaiting player connection. Prepare a dedicated reversible fixture using fresh original scene/pause/token/door/light state. Do not consume inference or change automatic-event settings. Request manual restart if server code changes, then verify loaded hashes before live acceptance. Restore approved fixture changes without touching the user-managed processes.
