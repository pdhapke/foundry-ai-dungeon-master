# Testing and fixtures

Run all gates from the module root:

```powershell
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run generate:docs
npm run check:manifest
```

Automated tests use in-memory or temporary SQLite databases, deterministic provider responses, synthetic Foundry/MCP results, and non-canonical document IDs. They cover replay/conflict, crash recovery, visibility budgets, stale summary invalidation, cross-domain tool discovery, grant denial, audience escalation, recipient-specific transcripts, WebSocket world isolation/session expiry, output delta repair, public sanitization/read-back, and operation without live keys.

Live validation must use a non-canonical fixture Scene/Actor/Token and must record active module/server versions, catalog/tool counts, identity, prompt acknowledgement, delivery, reconnect, and Foundry read-back. Do not use live campaign Actors, Items, Scenes, combat, or secrets as destructive fixtures.
