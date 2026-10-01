# Changelog

## 0.1.0 — 2026-09-29

- Created the standalone Foundry v14 **AI Dungeon Master** module.
- Added durable event/run/transcript/outbox storage and crash recovery.
- Added recursive visibility-aware campaign context, receipts, and signed capsules.
- Added trusted MCP catalog search and deferred tool definition loading.
- Added server-only OpenAI Responses orchestration and deterministic mocks.
- Added proposal/approval policy primitives and fail-closed legacy mutation handling.
- Added automatic Foundry-authenticated window transport, short-lived local sessions, streaming state, reconnection recovery, and audience isolation.
- Added disabled-by-default automatic combat, door, Region, Item, and Scene adapters.
- Added audience-wide context disclosure enforcement, validated-final-only streaming, scoped run
  cancellation, proposal discovery binding, and player diagnostic redaction after adversarial review.
- Live-validated Foundry v14 discovery, activation, Scene control, and disconnected fail-closed UI in
  the disposable `mcp-test` world.
- Movement and voice remain intentionally disabled.
