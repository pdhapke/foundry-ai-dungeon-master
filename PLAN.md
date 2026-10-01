# AI Dungeon Master implementation plan

## Phase status

- [x] Separate module boundary, shared protocol, and trust model.
- [x] Durable event/run/message/outbox foundation and recovery.
- [x] Revisioned recursive context service and continuation capsules.
- [x] Trusted deferred tool catalog with cross-domain discovery tests.
- [x] Server-only Responses runner, bounded retries/cancellation, and proposal policy.
- [x] Direct prompt UI, transport, streaming state, transcript recovery, and audience enforcement.
- [x] Direct and automatic-event normalization through one server pipeline.
- [x] Combat, door, Region, Item, and Scene adapters implemented behind an off-by-default gate.
- [ ] Live automatic Foundry authentication, window submission, MCP inventory, and OpenAI prompt smoke test.
- [ ] Add provider capabilities with native expected-revision and idempotent commit guarantees; keep legacy mutations refused until then.
- [ ] Add roll adapter after a system-neutral resolved-roll contract is available.
- [ ] Enable movement only after the movement cursor/schema health gate passes.
- [ ] Add voice capture/transcript confirmation as a new event source without changing transport semantics.

The module must not be described as complete while any unchecked live or commit-safety gate remains.
