# Prompt 4 independent player panel / bootstrap gate

Scope: independent static review of `module/src/ai-dungeon-master/player-observation-panel.ts`, application/template hooks, Python `/chatkit/thread`, and enrolled-thread action/respond/endpoint guards. Independently reran existing focused tests with local mocked environments. No browser, network, model, or runtime restart occurred.

## Independently verified offline

- Panel selects exactly one currently controlled token and an active non-GM owner. `User.query` probe checks exact target user/player lane, current consent, connection and returned client ID; it sends only `action:probe`, never enroll/consent mutation.
- Bootstrap sends only five audience identifiers. Python authenticates gateway GM, validates exact selection/world, creates an empty dedicated SDK thread and stores the immutable audience binding before returning its ID. No private GM items are copied and no inference is invoked.
- Player component custom fetch permits only same-thread `threads.get_by_id` / `items.list` and exact armed `foundry.player-observation` payload. Ordinary composer, retries, thread lists and alternate GM thread access are denied. API credentials/original headers are not forwarded; existing authenticated gateway headers are supplied freshly.
- Python enrolled safe threads reject ordinary GM `respond`, context actions, add-message and retry inference before history/model reconstruction. Deterministic action has two authenticated surroundings reads, source/world/player/client/token revision/provenance validation, separate observation records and safe text-only SDK items. GM protocol pairs remain in GM threads.
- Local panel world/GM/scene/token/ownership/revision fence runs before requests, after response headers and before/after every streamed chunk. Cancellation aborts outstanding requests, removes component and unregisters hooks. Changing selected player cancels the old lane; probe/client drift cannot silently reuse its history.
- Safe action skips provider authorization resolution in gateway; safe thread bootstrap also requires no provider/model. Receipt descriptions come from approved observable contracts, not SDK user text or unrestricted GM prose.

Independent reruns:

- `node --import tsx --test module/src/ai-dungeon-master/player-observation-panel.test.ts`: **5 passed**.
- `chatkit-server/.venv/Scripts/python.exe -m unittest test_player_bootstrap_independent -v`: **3 passed**.

The test named “mounted SDK flow” uses a hand-written `Component` mock and DOM-like nodes. It checks the custom-fetch policy and request shape but does **not** instantiate the actual ChatKit custom element, paint in Foundry, exercise real User.query transport, or prove streaming SDK behavior. Python bootstrap tests use an in-process FastAPI client and store; they prove server contracts, not loaded runtime identity.

## Review finding

Application `_onRender` can replace the panel host without canceling/reparenting its current `PlayerObservationPanel`. Its detached custom element, pending work and hooks may survive until close/reopen. No private-history or inference bypass was identified, but stale detached work is a lifecycle defect. Reported to root; native worker assigned repair. Root must independently confirm rerender cancellation after that change. This reviewer owns only this evidence document and did not edit implementation.

## Acceptance limits

Actual embedded custom element compatibility, browser receipt rendering, real probe/consent/disconnection, loaded server/client markers and late-stream cancellation remain untested here. Backend rejects wrong identities and stale observations; that does not establish actual intended-player browser paint. The panel is a safe receipt view in the GM application, not a new authenticated player chat endpoint. Existing ordinary GM chat remains private adjudication with weaker policy-only secrecy if its prose is shared with players.

No additional inference, automatic events, consent changes or runtime settings were enabled. No post-restart or live narration claim is made.

## Root repair verification
Root inspected application._onRender cancellation and independently reran application.player-panel-cancellation.test.ts:1 passed. The regression mounts the panel, rerenders, and checks detached controls disabled plus7 hooks removed. Worker final module69/69/typecheck/build passed. Prepared identities recaptured after final build. Actual browser limitations above remain.

