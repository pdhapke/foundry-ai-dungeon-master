# Known limitations

- Foundry v14 package discovery, activation, Scene-control integration, and disconnected-window behavior are live-validated in `mcp-test`; automatic authenticated prompt submission and a paid/live OpenAI response have not yet been smoke-tested.
- The reviewed `foundry-local-api` write tools currently lack the combined revision/idempotency contract required for automatic commit, so production consequential writes fail closed. Policy and storage commit primitives are covered with synthetic tests.
- Approval cards can be rendered and decisions are durably modeled, but the production approval command and commit authorizer remain intentionally unwired until a revision-safe/idempotent provider contract exists. A failed or cancelled provider run has no one-click retry: after dispatch or an interrupted stream, automatic replay could duplicate plan usage, so a GM must first verify authorization and model readiness before deliberately submitting a new prompt.
- Delivery outbox acknowledgement currently occurs after WebSocket send rather than an explicit client acknowledgement. Transcript messages recover in order, but transient status and approval deliveries require a future client-ack protocol before they can be claimed as lossless.
- Automatic combat, door, Region, Item, and Scene adapters ship disabled. A GM must enable the world setting after direct-prompt validation.
- Movement-driven runs are not implemented; movement cursor/schema health remains an explicit gate.
- A system-neutral resolved-roll adapter and voice capture/transcription are not implemented.
- Non-GM or multi-recipient runs use presenter-view context constrained to the complete delivery audience. GM-only/private-GM runs may use resolver secrets; a richer fact-level declassification workflow remains future work.
- Only the two deterministic campaign seed documents are loaded initially; additional campaign files are reached through explicit context relationships after their formatting is reviewed.
