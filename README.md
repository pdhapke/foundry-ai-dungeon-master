# Embedded ChatKit milestone

AI Dungeon Master embeds the official OpenAI ChatKit web component in Foundry VTT 14. Manual messages and the **Respond with scene context** button share one durable conversation per Foundry world and GM. This milestone is GM-only; players cannot open or read its conversations.

The web component streams through the existing authenticated Node companion (`POST /chatkit`, port 3940), which validates the current Foundry world and GM through the preserved Local API MCP integration. A Python `openai-chatkit` service on loopback port 3941 implements the supported custom ChatKit protocol and stores conversation items in SQLite. The Node companion starts and terminates that service in its process tree. Browser code receives short-lived Foundry enrollment credentials, never OpenAI credentials.

## Setup and startup

From this module directory:

```powershell
npm install
python -m venv chatkit-server/.venv
chatkit-server/.venv/Scripts/python.exe -m pip install -r chatkit-server/requirements.txt
npm run build
```

Python 3.13.1 was tested. On Linux/macOS use `chatkit-server/.venv/bin/python` for the installation command. Copy `server/.env.example` to the ignored `server/.env` only if it does not exist. For the existing ChatGPT account sign-in route, keep:

```dotenv
AI_DM_CHATKIT_AUTH=existing
AI_DM_ENABLE_API_KEY_FALLBACK=false
```

Open the panel as a GM, select **Continue with ChatGPT**, complete the sign-in popup, and select an eligible model. Authorization and refresh tokens remain encrypted on the server; the Python sidecar receives only server-held authorization for the selected model. Subscription status alone does not prove that the provider accepts the request; live verification still requires successful authorization and a streamed response. No new OAuth infrastructure is introduced.

An authorized API key is an optional alternative. Explicitly choose it in `server/.env`:

```dotenv
AI_DM_CHATKIT_AUTH=api-key
AI_DM_ENABLE_API_KEY_FALLBACK=true
OPENAI_API_KEY=<your authorized OpenAI API key>
OPENAI_MODEL=<your available Responses model>
```

This selection bypasses retained world sign-in authorization for ChatKit without deleting it. Default `existing` mode fails closed when connected authorization is ineligible. Never put credentials in Foundry settings or source control.

Start Foundry normally through the existing `App/main.js` installation hook. It starts Local API and the Node companion; Node starts Python automatically. Enable AI Dungeon Master in the world and open its scene-control button or keybinding as a GM. Optional interpreter override: `AI_DM_CHATKIT_PYTHON`; port: `AI_DM_CHATKIT_PORT=3941`; database: `AI_DM_CHATKIT_DATABASE_PATH`. Health endpoints are `http://127.0.0.1:3939/health`, `http://127.0.0.1:3940/health`, and `http://127.0.0.1:3941/health`.

The official component loads from the OpenAI CDN and requires network access. Exact loopback browser hosts (`localhost`, `127.0.0.1`, `[::1]`) default to the `local-dev` key shown in the [official ChatKit quickstart](https://openai.github.io/chatkit-js/quickstart/). Other hosts require an accepted ChatKit domain key configured in Foundry under the GM-only ChatKit domain key setting (`chatKitDomainKey`) for the exact browser origin. A configured key always overrides the local default. Configuration and runtime failures appear in the panel. No automatic event inference or automatic retries are enabled.

## Programmatic entry point and transmitted context

Use the module's `game.modules.get("foundry-ai-dungeon-master").api.trigger({ prompt, context, requestId })` entry point (see frontend API implementation). Calls target the same panel conversation. Supply a unique request ID for each intended action; repeated IDs are deduplicated, and an overlapping request is rejected. Closing the panel cancels its active stream.

Context is limited to scene ID/name, controlled token IDs/actor IDs, target token IDs, combat ID, round and turn. Arrays are bounded. Journals, actor sheets, hidden GM notes, credentials and unrestricted documents are not extracted. All game context and future tool results are untrusted data. The current server-side tool extension point is deliberately empty; existing authenticated MCP catalog and transport remain available for future authorized tools.

## Verification and evidence

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run check:manifest
chatkit-server/.venv/Scripts/python.exe -m unittest discover -s chatkit-server -p "test_*.py"
```

See [implementation ledger](CHATKIT-LEDGER.md), [audit](CHATKIT-AUDIT.md), [official architecture evidence](CHATKIT-ARCHITECTURE.md), and [integration verification](CHATKIT-INTEGRATION.md). Passing builds and mocked streams do not prove live OpenAI or Foundry inference; evidence states each scope separately.
