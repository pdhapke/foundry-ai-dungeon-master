# Prompt 1 panel preparation

Owned files: module/src/ai-dungeon-master/application.ts, panel-preparation.ts, panel-preparation.test.ts; rebuilt module/dist/index.js.

The panel starts one authenticated POST /chatkit/prepare on GM panel opening or relevant connection/provider/model state changes. The browser sends only the existing short-lived Foundry session headers and an empty body. Credentials remain server-side. Commands needing model input await the same pending preparation request. Existing request authorization is retained.

States: Preparing, Ready, Reconnect required. Ready means server-checked credentials and bounded campaign prerequisites within the returned validity window. It does not guarantee provider acceptance or native/player perception, and does not authorize an action. Disconnect, authentication change, provider/model change, owner switch, expiry, cancellation and close invalidate readiness. Expiry updates the status without a periodic refresh loop. Preparation has a 15-second cancellation deadline and bounded failure backoff; explicit Refresh status or a later submission can retry. Closed panels abort/fence pending preparation and delayed responses.

Offline evidence: docs/prompt1-panel-tests.txt records 75 module tests passing, including single-flight calls, stale response fencing, reconnect, invalid/expired/unavailable responses and retry backoff. Module typecheck and esbuild passed. Tests use mocks and consume no inference. Independent validation is delegated to the parent validator.

Boundary: native Foundry/player enrollment acceptance remains deferred; earlier narrow deterministic corridor observation does not establish broad secrecy or encounter acceptance. UI inspection against the loaded build has not been performed. Server runtime changes require Peter's manual shutdown/restart and loaded-build verification. No runtime restart, browser reload, gameplay mutation, automatic-event setting change or inference was performed by this worker.

Deployment limitation: unauthenticated static Range206 access to existing private campaign Markdown was confirmed by the parent review. Preparation Ready does not establish campaign-file privacy. The Ready caption explicitly states: "Private campaign-file protection and player/TV acceptance remain required." Private campaign writes remain fail-closed in the server work.
