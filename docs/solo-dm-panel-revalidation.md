# Independent panel revalidation

October 1, 2026. Offline panel subtask gate: **PASS after repair**. This validator
did not implement the panel. Independently revalidated both cancellation/readiness
and world/user pointer repairs against the frozen application.

## Positive evidence

Ran the current complete module suite: **32 passed**, including the original
independent readiness regression and repaired cancellation coverage at thread
HTTP, response body and component thread selection awaits. Module TypeScript
check and module build also passed. Inspected application, campaign exact-review
helper/tests, template and cancellation tests.

`dispatchTrigger` now captures cancellation/generation and checks closed state,
world/user and component identity after readiness/render/mount, thread fetch/body,
programmatic thread selection, and custom-action awaits. Cancellable waiting stops
continuation even for noncooperative promises. Cancellation aborts queued/current
request signals, clears review listeners and prevents late queued action dispatch.
Existing reopen/listener cleanup tests pass. Exact campaign approval requires a
complete digest-bound before/after review, scope and hashes; summary rows have no
approval. Text uses textContent, and completion display requires a matching receipt.

## Independently reproduced failure and verified repair

Added a separate independent regression:
`module/src/ai-dungeon-master/application.panel-revalidation.test.ts`.
It mounts the existing panel, cancels, changes the live world and user, then emits
a late `chatkit.thread.change` from the original mounted component. No network,
model or actual Foundry activity is performed.

Before repair, observed result: localStorage key
`foundry-ai-dungeon-master.chatkit.thread.different.other-user` receives
`old-owner-thread`; expected no entry. The independent test exited **1**. After
repair, the same untouched independent regression passes with no cross-owner
pointer entry.

Original cause: the mounted component thread-change listener only rejected a known stale
programmatic selection generation. It then mutates `#threadId` and calls
`pointerKey()`, which derives its world/user from the current live game rather
than the owner captured by this panel. A cancelled panel's old thread event can
therefore overwrite another world's/user's conversation pointer. Server thread
authorization should still reject accessing that old conversation, but the UI
scope/reconnect contract is broken and the old component must not mutate it.

Verified implementation now captures a mount generation and thread pointer key
from the panel's world/user. It checks closed state, mount generation, component
identity and current owner before accepting a thread event or mutating a pointer.
It also checks owner/generation after runtime loading before mounting. Close
invalidates mount generation. Trigger HTTP/body and inference digest paths retain
their post-await owner/cancellation checks. These repairs resolve the reproduced
scope defect without weakening exact review or reopening tests.

## Scope and limitations

No implementation or original validation files were altered. Changed only this
report and the separate regression. Build generation was explicitly requested;
the build was not loaded or deployed. These tests use mocked component/DOM/game
objects and prove control flow, not live Foundry behavior. Physical Regions,
remote combat, loaded-build identity, actual reconnect/cancellation and privacy
remain separate live gates.
