# Prompt 3 compact layout implementation

Implemented frontend scope only. Runtime deployment, loaded identity, user-browser screenshots and measured usable pixels remain root-owned acceptance gates; no live UI observation or inference is claimed here.

## Presentation

Healthy authorized play has a compact Model selector and native keyboard-accessible Account/settings details menu. Healthy Ready prose, model-available/domain reminder and persistent introductory paragraph are absent. Sign-in/reconnect is hidden while identity and model-use authorization remain valid, including model-selection-pending/unavailable states; actionable model, provider and Foundry failures remain visible. Selected models must actually appear in the eligible list before provider status is silent. Domain validation is untouched and missing/invalid-domain/CDN errors remain visible. A delayed successful preparation response cannot hide a mount/request error.

Account/settings contains model-free Check connection, sign-out/account switching, Review proposed actions and receipts, Player surroundings and zero-model Campaign setup. Escape closes the menu and restores summary focus. Diagnostic export exists only when the registered latencyDiagnosticsEnabled setting is exactly boolean true; default registration is owned by the root integration worker. Diagnostic payload generation remains the existing bounded metadata-only latency probe.

The ChatKit host flexes into remaining space with a 120px minimum (previous 280px); the menu overlays rather than consumes transcript space. Review drawer and secondary observation/setup panels are bounded scrolling regions. These are source-layout decisions, not measured browser improvements. Actual compact viewport clipping/composer/menu acceptance remains required.

## Safety controls

Stop appears only during response/guard/queued-trigger work, never because a review/status read exists. It invokes the existing cancel handler: abort local fetch/stream controllers, queued trigger generation and automatic lifecycle; invalidate stale review UI. No provider stop or rollback guarantee was added. The resulting visible message explicitly says confirmed changes remain and server/provider work may have completed; inspect receipts before retrying. Durable history/tool protocol and backend authorization remain unchanged.

Review proposed actions is not redundant. It fetches native action receipts and private-session-note approvals, attack decisions/receipts, exact campaign-file proposals/receipts, exact native-world proposals and exact world-file proposals. Existing approval/reject/cancel handlers, expiry checks, digest checks and exact-byte validation remain intact. The manual menu reveals the drawer. After response end, one coalesced read-only five-kind batch detects pending notes/campaign/world proposals or attack decisions and reveals the drawer without approving anything. Concurrent automatic/manual batches share the selected thread+review epoch; stale batch errors cannot surface after cancellation/thread changes. Completed receipts remain available manually. Five reads per completed response is bounded, with no polling/model call.

## Offline validation

Module full suite passed 86/86 in docs/prompt3-layout-tests.log (count includes concurrent root tests; do not sum with focused counts). Module typecheck passed. Final focused compact provider/error/Stop tests passed 2/2 after expanded response-start/end assertions. Existing cancellation and exact review approval tests passed in the full suite. Final menu Escape source addition needs the aggregate root check.

No aggregate build, runtime restart, model request, gameplay mutation, campaign publication, push or outside-scope edit performed by this worker. No baseline/after screenshot or viewport delta available from this worker; root reported trusted desktop runtime unavailable and retains the actual browser gate.
