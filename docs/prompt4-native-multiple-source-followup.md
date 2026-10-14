# Native multiple-source follow-up (offline source inspection)

Root reports exact player-owned primary and second linked tokens, second created after scene view, selected second returns TOKEN_VISION_INACTIVE. This worker did not observe browser/runtime or execute actions; the report is supplied live evidence. No code, native sources, permissions, settings, services or fixtures were changed by this worker.

Installed Foundry14.368 `App/client/canvas/placeables/token.mjs` lines983-1006 `_isVisionSource`:

1. Scene token vision and token sight must be enabled; token must occupy current viewed level; hidden tokens excluded for non-GM.
2. A controlled token with sight is eligible.
3. Uncontrolled tokens never provide GM vision.
4. For non-GM, actor OBSERVER permission is required; an uncontrolled token becomes eligible only if **no other controlled nonhidden token has sight**.

Therefore player ownership of both tokens does not imply both sources remain active while only the primary is controlled. The shared linked actor does not explain source inactivity; the native current controlled-token set does. Newly created token `_onCreate` at3989 initializes sources, then auto-controls an owned nonhidden token only if no token was already controlled. Existing primary control prevents the second from being auto-controlled. This explains the reported result without attributing it to the adapter or borrowing GM sources.

## Supported targeted player UI sequence

Preferred: keep the exact opted-in player browser on the fixture and **Token Select** tool. Shift-click the already controlled primary once, without dragging. `App/client/canvas/placeables/placeable-object.mjs` lines1227-1243 sets interactionData.release for Shift-click of an already controlled object, then `_onUnclickLeft` calls native `release()`. Native `Token._onRelease` lines4637-4647 reinitializes vision sources for every placeable and schedules perception refresh. With no controlled nonhidden sight token, both actual player-observable/owned fixture tokens become eligible under their existing native actor permissions. Do not force-control or insert/modify a source in browser JavaScript.

Alternate conditional UI: ordinary click empty canvas releases all only if existing core `leftClickRelease` is enabled and there is no hover/Shift; `layers/base/placeables-layer.mjs`1083-1088. Do not toggle this setting just for the test. Shift-click primary avoids that setting dependency. Escape is not a reliable player release method: `_onDismissKey`1307 explicitly requires GM.

Ctrl+A is core Select All (`helpers/interaction/client-keybindings.mjs`361-366 and692-697), routed to current active layer. `PlaceablesLayer.controlAll`457-471 controls eligible objects with releaseOthers:false. However `controllableObjects`169-174 enumerates only visible/renderable/interactive placeables, and `PlaceableObject.control`701-724 additionally checks supported native control permissions. A second token behind the closed barrier might not be currently eligible/visible under primary-only vision, so Ctrl+A cannot be assumed to activate both from that initial state. After releasing primary, normal permitted union visibility may allow Ctrl+A to visibly select both; it still must be observed, not inferred.

Re-view also has qualifications: `App/client/canvas/board.mjs`1570-1600 restores cached controlled-token IDs on same-scene reload before considering player-owner defaults, so reload/re-view need not release primary. A genuinely changed scene view without reload/control options uses assigned character active tokens or, if absent, all actor-OWNER tokens, controlling same-level tokens with releaseOthers:false. This may pan and touches an unrelated scene/view; use the narrowly targeted Shift-click release instead.

## Evidence gate and restoration

After native release and completed perception refresh, root observes actual intended-player rendering and runs model-free authenticated requests selecting **each token separately**. Primary's point beyond the closed/secret wall should remain occluded; second's local point may be visible. Canvas union visibility does not authorize merging the two results into primary's perspective. Source attribution and query elevation semantics remain unchanged; hidden nonowned target stays filtered. A selected-token request with no active source must continue TOKEN_VISION_INACTIVE/unsupported/incomplete, not successful synthesized sight.

No selection or ownership change can waive exact opted-in player connection/consent/scene/world checks, including asynchronous acceptance. Track selected/controlled-token browser state separately from native document persistence. Release/control may update native fog under configured exploration; cleanup must still remove and verify fixture fog while fixture scene exists. Restore original targeted scene/view and any captured original control state through normal permitted UI; do not change unrelated clients or settings. One successful basic ground-level source case does not prove all vision modes/elevation/path/trap interactions.
