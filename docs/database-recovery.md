# Database schema and recovery

The Node 24 SQLite database uses WAL, foreign keys, full synchronous writes, a busy timeout, startup `quick_check`, checksum-pinned transactional migrations, and online pre-migration backups. Migration 1 creates operational event/run/context/tool/proposal/outbox/synchronization tables. Later migrations add hashed local-session records and revoke records created by the retired enrollment flow.

No raw local-session credential is stored. Credential-shaped JSON keys are redacted at repository boundaries. Transactions contain no model, HTTP, MCP, or Foundry call. Database recovery never requires an operator token, enrollment code, browser credential, or the ephemeral process-tree broker secret; restart Foundry normally so a new broker secret and browser session can be established.

Startup recovery fails interrupted runs. Pending consequential executions and committing proposals become recovery-required/conflicted; they are never assumed successful. Expired outbox leases return to pending. Filesystem campaign truth and Foundry document truth remain outside this database.

The connected GM's model selection does not bypass account discovery after restart. Before inference, the server revalidates that the selected or configured preference remains in the eligible model list. If discovery or validation is unavailable, inference fails closed; recovery never switches to API-key fallback on that basis.
