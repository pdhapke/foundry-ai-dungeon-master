# Prompt 3 independent validation gate

2026-10-04. Independent source and mocked-state validation only. No inference, gameplay mutation, approval decision, server/Python edit, runtime restart or publication.

## Phase 1: source inventory passes; rendered baseline open

Reviewed Prompt 1 implementation/context-admission and Prompt 2 handoffs, `prompt3-control-audit.md`, module application/template/provider/readiness/latency code, Node gateway cancellation/authorization, and Python completion persistence. The control audit accurately distinguishes browser session proof, current Foundry GM/world permission, provider OAuth/model authorization, and registered ChatKit domain configuration. None grants the other permissions.

**Cancel response:** local queue/generation fences and fetch/stream abort propagate cooperatively through Node upstream cancellation and Python disconnect handling. Already dispatched tool/provider work may complete. No rollback or no-cost guarantee is justified. Complete tool call/output pairs and confirmed receipt messages persist in Python completion hooks before display; cancellation before completion/acknowledgement can leave an uncertain result requiring current-state/receipt inspection. Keep the review path reachable.

**Review proposed actions:** opens five authenticated review lists, including pending exact proposals, consequential attack decisions, and confirmed/uncertain receipts. This is required approval access as well as history. Presentation changes may move it to a clearly named menu/contextual area; automatic approval or removal is unsupported. Existing digest, expiry, identity, review epoch and explicit decision checks remain necessary.

The installed ChatKit types expose no supported public stop method. A widget-native Stop control requires actual observation of the loaded CDN widget. No browser dimensions, screenshots, composer measurements or loaded-build claims are made here.

## Independent readiness tests

`module/src/ai-dungeon-master/prompt3-independent-readiness.test.ts`: 3/3 passed before implementation integration. Covers cancelled/reopened generation with stale completion, concurrent demand coalescing, expiry without idle refresh, and failure backoff bounded to 30 seconds with explicit invalidation recovery. These are deterministic mocked requests, not live provider calls.

## Phases 2/3: integrated offline module gate passes

Independently reviewed compact template/CSS/state helper, application event/review/stop/error handling, diagnostics setting, controller and transport status lifecycle. Healthy provider/model status, Ready sentence, domain instruction and sign-in clutter are removed from healthy presentation. Unavailable model, missing domain/CDN, signed-out/unauthorized and disconnected guidance remains. Native `details` account/settings and review drawer retain keyboard-accessible controls; diagnostics requires the explicit default-off flag. Actual focus behavior and clipping remain visual gates.

The original pending-proposal decisions, exact digest/expiry checks, durable confirmed/uncertain receipts and review epochs remain. Contextual review reads use model-free action lists after responses; concurrent list batches share the same thread/epoch request. Stop is shown only during queued/active response work and its message preserves confirmed changes and uncertain provider/server outcomes. It does not promise rollback.

Found a race during review: an older in-flight provider status could overwrite a newer signout/model-selection result. Worker repaired this by closing only discovery status work before provider mutations and retiring bounded own request IDs. Its regression covers sign-in, signout and model selection. Meaningful invalidations during an outstanding refresh now queue one follow-up; plain repeated open events coalesce. Current-GM/browser identity checks and renewal isolation remain. Closing the panel cancels status timers and no recurring status interval is installed; OAuth fallback is bounded to six checks. Status failure exposes corrective guidance without altering authentication.

Independent integration run: `npm test --workspace=module` **92/92 passed**, followed by `npm run typecheck --workspace=module` passed. Logs: `prompt3-final-module-tests.log`, `prompt3-final-module-typecheck.log`. Count includes overlapping imported fixtures; do not add focused counts as unique tests. Focused lifecycle run before the last fixes was 30/30; the complete integrated run supersedes it. Existing cancellation tests exercise thread HTTP/body/component readiness, close/reopen and stale world-pointer fences; mocked compact tests verify readiness cannot hide a missing-domain error and Stop changes with response events. No real provider/tool cancellation is claimed from mocks.

Added independent settings integration test exercising actual `index.ts` registration callbacks: diagnostics defaults off; diagnostic changes avoid configuration invalidation; disconnected Check connection remains enabled and reconnects without a model request; server URL changes reconnect authentication once and block stale panel fetches until reopen; domain changes retain a visible corrective guard. Supported ready on a stored thread and thread-selection events each trigger five review reads; simultaneous contextual checks share one batch. Invalidating reviews hides/closes the stale drawer. Independent readiness tests also assert manual refresh bursts do not abort a valid pending preparation.

Final isolated presentation followup hides only the exact ordinary preparation-cache expiry caption, preventing a recurring idle banner without refreshing. Cache state still expires and next request checks prerequisites; genuine browser/provider expiry, model, configuration and preparation failures stay visible. Focused compact/readiness **4/4 passed** after that edit (`prompt3-final-compact-readiness-tests.log`); these overlap the 92-test run and are not additional unique tests.

## Phase 4: browser/runtime gate open

No trusted browser/desktop tools were available to this validator. No baseline screenshot, viewport size, usable transcript/composer measurement, native widget Stop observation, resizing/focus/scrolling acceptance or loaded-build validation is claimed. Parent owns deployment; aggregate server/Python builds are held while Prompt 2 workers continue. No server/Python tests were run by this validator to avoid overlap. Actual rendered acceptance must stop for Peter's visual feedback before further redesign.
