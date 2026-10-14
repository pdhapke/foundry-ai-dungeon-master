# Prompt 3 control audit

Read-only source audit, 2026-10-04. Prompt 1/2 handoffs were read. This is handler evidence, not a rendered-window observation or loaded-build assertion. No inference, runtime operation or implementation change occurred during this audit.

## Control inventory before edits

| Named control | Component/state | Handler and route | Purpose/dependency |
| --- | --- | --- | --- |
| Ready sentence | `PanelPreparation` publishes into `.ai-dm-chatkit-status`; after a successful `/prepare`, and restored on response end | `checkPreparation`/`ensure`, POST `/chatkit/prepare` | Checked credential/context admission with expiry, not guaranteed provider acceptance, campaign completeness or player perception. Current actual sentence differs from saved prompt. |
| Every message/context instructions | Permanent `.ai-dm-context-notice` in `application.hbs` | No handler | Informational copy only; does not enforce permission/approval. |
| Model available/domain instructions | `chatGptPanelStatus`, healthy provider status | No handler | Redundant selected-model prose plus unconditional domain reminder. Domain validity is independently checked during mount. |
| Model dropdown | `.ai-dm-provider`; selected eligible options, disabled without connected GM/usage authorization/models or while pending | `selectChatGptModel`; WebSocket `aiDm.chatgpt.model.select`, then `aiDm.chatgpt.status`; `server/src/index.ts` calls `chatGptAuth.selectModel` | Server checked account/model choice. Must preserve unavailable/empty/no-selection failures and confirmed selection. |
| Continue with ChatGPT | Permanent GM toolbar; disabled outside connected GM lane | `beginChatGptSignIn`; popup plus WebSocket `aiDm.chatgpt.signin.begin`; server `chatGptAuth.begin` | Provider OAuth/account authorization, not browser enrollment or ChatKit domain registration. |
| Logout | Actual label is **Sign out**, permanent toolbar, disabled without connected GM or connected identity | `signOutChatGpt`, WebSocket `aiDm.chatgpt.signout`; server `chatGptAuth.signOut` | Provider account signout and switching; does not remove Foundry browser authorization. |
| Refresh status | Permanent GM toolbar | `refreshPreparation` plus `refreshChatGptStatus`; POST `/chatkit/prepare` and WebSocket `aiDm.chatgpt.status` | Model-free recovery/discovery/preparation; retain reachable manual recovery. |
| Export latency diagnostics | Appended after mount in `application.ts` | `latencyDownloadButton` local JSON download | Bounded browser timing metadata only; exported rows contain clocks/stages/trace IDs, no prompt bodies, campaign text or credentials. Passive parser briefly buffers response chunks internally; it does not export them. |
| Cancel response | Permanent GM toolbar | `cancel()`; abort controllers and generation fences, no dedicated cancellation endpoint | Cooperative cancellation described below. |
| Review proposed actions | Permanent GM toolbar | `reviewActions`, five parallel POST `/chatkit/actions` list reads | Required approval access and receipts, described below. |

Sources: `module/src/ai-dungeon-master/application.ts`, `application.hbs`, `chatgpt-panel.ts`, `controller.ts`, `transport.ts`, `panel-preparation.ts`, `latency-probe.ts`; `server/src/index.ts`, `server/src/chatkit/gateway.ts`; `chatkit-server/app.py`.

## Four independent layers

1. Browser-to-service proof is the existing bound Foundry session/enrollment. `transport.chatKitHeaders` checks expiry/renewal and supplies identity proof only to the allowed local gateway origin/paths. A browser authentication failure does not prove provider OAuth expiry.
2. Current Foundry GM/world authorization is revalidated by the gateway before and during work. Panel identity fences bind its original world/user. A signed-in provider account cannot grant Foundry GM permission.
3. Provider OAuth identity, usage authorization, expiry and eligible selected model belong to `chatGptAuth`. Identity connected is insufficient when plan usage is unauthorized, discovery failed/empty, or selection is unavailable.
4. ChatKit registered-domain key is custom API configuration. `chatKitDomainKey` supplies the documented local development key only on loopback and otherwise requires configuration. Mount rejects missing keys; a 20-second ready timeout reports domain/CDN failure. A nonempty configured key is not proof of successful domain registration. Hiding healthy prose must retain mount and ready validation.

## Cancel response in plain language

Stop cancels this panel's queued responses and active browser stream, invalidates preparation and review loads, and cancels its automatic-event lifecycle. The browser fetch/stream abort reaches Node's disconnect handler; Node aborts the upstream request and reader. Python's streaming endpoint detects disconnect and closes its event iterator. These are cooperative boundaries: already dispatched provider or tool work can race with cancellation. There is no proof here that provider generation always stops immediately or that a request costs nothing.

Stop does not undo an already confirmed game change or delete conversation history. Python's `on_tool_end` explicitly persists complete call/output pairs before display and durable receipt messages. A cancellation before that completion hook or an acknowledgement race can leave an uncertain outcome requiring receipt/current-state inspection. Preserve event deduplication/pending identity and complete stored history; do not automatically resubmit a mutation. The UI should say stopped/inspection required, without promising rollback.

Installed `@openai/chatkit` is 1.9.0, a types-only package. Its public `OpenAIChatKit` methods have no stop/cancel method. Supported configuration includes custom `api.url`, `api.fetch`, required `api.domainKey`, composer/history/theme/header options, and response start/end events. The actual widget is loaded from the OpenAI CDN, so an internal composer Stop control must be established by actual visual observation. Do not use shadow-DOM or iframe manipulation to detect/control it. An external contextual Stop remains supported through the existing custom fetch abort mechanism, including pre-dispatch/queued work that widget controls may not cover.

## Review proposed actions in plain language

This button opens both decisions waiting for the user and records of actions already attempted. It is not merely a speculative preview:

- Native pane: notes show exact proposed private session-journal text and pending Approve/Reject controls; other native actions show statuses/receipt totals.
- Attack pane: scoped recorded attack/damage outcomes; decision-required entries can apply recorded damage after the stated player decisions are resolved. This is a consequential action, not an informational history row.
- Campaign pane: validated exact proposed batch, bodies/digests, explicit decisions and factual receipt text. Revision/digest/expiry checks remain.
- World and world-file panes: validated exact proposed changes, scope/digest checks, explicit approve/reject/cancel and retained outcome review.

All use POST `/chatkit/actions` through authenticated current-GM checks. Selecting a review is a model-free read; approving/applying invokes existing authorization and mutation policy. Thread changes/cancel clear stale visible controls through review epochs, not durable proposals/receipts.

Recommendation: retain **Review actions and approvals** as a clearly named account/settings menu entry and keep pending decisions contextual when independently known. Do not remove, autoapprove, or infer absence of proposals from an unloaded list. Receipt recovery must remain reachable after cancellation/reconnect. Source evidence supports presentation changes without approval-policy changes.

## Safety and recovery dependencies

Preserve current-GM/world checks, provider authorization/model discovery, domain/CDN ready errors, bounded preparation timeout/expiry/backoff, manual model-free refresh, sign-in/reconnect/signout, request abort and generation fences, pending event IDs, exact review digests and explicit decisions, full protocol history and confirmed/uncertain receipt recovery. Existing `PanelPreparation.ensure` coalesces pending work and has bounded retry windows; normal lifecycle changes must reuse it rather than add a new polling/auth subsystem.

Independent source audit completed. Browser baseline dimensions/screenshots and visual/native-Stop observations remain the deployment/browser owner's acceptance gate.
