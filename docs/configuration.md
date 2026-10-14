# ChatKit configuration

All secrets remain in ignored `server/.env` or the process environment. Never store provider keys, cookies, internal secrets or authorization tokens in browser settings, logs, URLs or Git.

| Variable                        | Purpose                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AI_DM_CHATKIT_AUTH`            | `api-key` explicitly selects the configured API key; default `existing` retains legacy authorization policy.         |
| `AI_DM_CHATKIT_PYTHON`          | Python interpreter; defaults to the repository-local virtual environment.                                            |
| `AI_DM_CHATKIT_PORT`            | Loopback Python port, default 3941.                                                                                  |
| `AI_DM_CHATKIT_DATABASE_PATH`   | Durable ChatKit SQLite database; defaults inside `AI_DM_RUNTIME_ROOT`.                                               |
| `AI_DM_ENABLE_API_KEY_FALLBACK` | Explicit opt-in to server-held OpenAI API credential use.                                                            |
| `OPENAI_API_KEY`                | Authorized server-only credential for explicitly selected api-key mode; retained world authorization is not deleted. |
| `OPENAI_MODEL`                  | Available Responses model, or eligible model for existing authorization.                                             |
| `AI_DM_FOUNDRY_ORIGINS`         | Exact allowed Foundry browser origins; default loopback port 30000.                                                  |
| `AI_DM_RUNTIME_ROOT`            | Operational storage root.                                                                                            |
| `FOUNDRY_LOCAL_API_KEY`         | Preserved internal server-to-server MCP credential supplied by Foundry startup.                                      |

The Node gateway verifies enrollment bindings including browser session, world, user, client and module version, then checks current GM identity via MCP. Python trusts only its ephemeral Node-generated internal credential and server-supplied principal. Neither internal credential is configured in the browser. Only GMs can access this milestone, so hidden GM conversations cannot be fetched by players.

The default `AI_DM_CHATKIT_AUTH=existing` route uses the GM panel **Continue with ChatGPT** sign-in and eligible-model selection. Existing encrypted authorization storage and automatic refresh remain intact. API keys are optional. A subscription alone does not prove provider eligibility; successful sign-in/model discovery and an accepted live streamed request establish that route. Connected authorization fails closed when ineligible. For the optional API-key route, set `AI_DM_CHATKIT_AUTH=api-key` and `AI_DM_ENABLE_API_KEY_FALLBACK=true`, then supply server-only `OPENAI_API_KEY` and an available `OPENAI_MODEL`. No authorization reset or new OAuth infrastructure is required.

Python and Node start under Foundry's normal process tree. Install pinned Python dependencies before startup; no new credential, billing configuration or deployment is performed by the setup commands. See the README for exact commands and `CHATKIT-INTEGRATION.md` for verification scope.

## Campaign storage and automatic observations

`AI_DM_WORLDS_ROOT` is the trusted server worlds directory, defaulting to the
module's sibling `../../worlds`. The live-authorized world determines its
`data/campaign` root; browser/model arguments cannot supply a filesystem root.
The production server supplies no private-storage verification callback, so
campaign proposal persistence returns storage_unavailable. No documented
environment flag bypasses this boundary. Protective deployment and a supported,
reviewed verification/enablement mechanism require approval and live privacy
tests before writes can be enabled; see [privacy](solo-dm-privacy.md).

The GM world setting `automaticEventsEnabled` is Boolean, restricted, default
false. It enables observations, not the DM identity. The keyed Region behavior
type is `foundry-ai-dungeon-master.keyedArea`, labeled AI DM keyed area entry,
with required `key` metadata (empty disables narration). Pending events cancel
when the setting changes. Live setup/reloads/model use remain approval-required;
see [live acceptance](solo-dm-live-acceptance.md).
