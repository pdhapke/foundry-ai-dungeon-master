# Always-on solo AI Dungeon Master

AI Dungeon Master embeds the official OpenAI ChatKit web component in Foundry VTT 14. Every ordinary message already talks to the same versioned solo dungeon master during campaign setup, preparation and play. The ordinary composer and application observations share the world/GM-scoped conversation; no identity or mode button is required. The integration is currently GM-only; players cannot open or read its conversations.

Each turn receives a dedicated bounded campaign overview (or explicit unavailable/missing status), current world/rules/scene/combat and validated party context. Relevant campaign Markdown is retrieved on demand under the active world's `data/campaign` folder. Exact campaign proposals require authenticated human review; only verified durable receipts establish canonical writes or completed game actions. Trusted tool discovery loads selected schemas/grants on demand; authenticated GM turns can discover reviewed session actions and typed world document controls. Routine changes use state preflight and durable read-back; destructive changes require exact review. Raw unrestricted MCP remains quarantined. See the capability coverage report for every admitted and excluded capability and the current independent/live gates.

**Private campaign persistence is disabled in the production wiring.** Installed Foundry serves campaign Markdown without session authentication; a read-only direct request confirmed HTTP 200. A supported reviewed proxy/backend protection design is documented, but no security configuration was applied. The production server deliberately supplies no privacy-verification callback, and there is no undocumented setting/environment switch to enable authoring. Protected deployment plus supported reviewed enablement wiring and live verification are future approval-required work. Offline temporary-filesystem authoring tests do not establish deployment privacy. See [privacy proposal](docs/solo-dm-privacy.md) and [live acceptance procedure](docs/solo-dm-live-acceptance.md).

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

## Waking an external AI Dungeon Master

Token movement is already queued, retried, and acknowledged inside the Local API process. With no wake URL configured, that queue keeps the placeholder adapter and does not call anyone. Set the variables below to POST each quiet period to your own receiver. The separate dot HMAC challenge webhook is unchanged.

The Local API process reads these variables, not the AI companion. Put them in `foundry-local-api/server/.env` (that process loads this file on startup). A real environment variable overrides the file. Do not put the secret in Foundry game settings or in git.

```dotenv
AI_DM_WAKE_WEBHOOK_URL=https://your-dm-host.example/wake
AI_DM_WAKE_WEBHOOK_SECRET=<receiver secret>
AI_DM_WAKE_WEBHOOK_HEADER=Authorization
AI_DM_WAKE_WEBHOOK_SCHEME=Bearer
AI_DM_WAKE_DEBOUNCE_MS=4000
AI_DM_WAKE_PLAYERS_ONLY=true
AI_DM_WAKE_ROOM_CROSSINGS_ONLY=false
AI_DM_WAKE_CHAT=false
AI_DM_WAKE_COMBAT_TURNS=false
```

`AI_DM_WAKE_WEBHOOK_HEADER` plus `AI_DM_WAKE_WEBHOOK_SCHEME` build the credential header. The defaults send `Authorization: Bearer <secret>`. For a receiver that wants the raw secret in another header, set `AI_DM_WAKE_WEBHOOK_HEADER=X-Api-Key` and `AI_DM_WAKE_WEBHOOK_SCHEME=` (empty). Leave the URL unset to keep the wake off. `AI_DM_WAKE_PLAYERS_ONLY` defaults to true, so a move is sent when the mover is not the GM client that reported it. `AI_DM_WAKE_ROOM_CROSSINGS_ONLY` defaults to false; set it true to POST movement only when the coalesced path crosses a room Region. Chat and combat turns default off. Chat and combat also need a Local API build that can observe bridge events without consuming them, plus the combat-turn hook from that repo. Movement does not.

Reload steps:

1. In this repo run `npm run build` so `server/dist/dot-extension.js` exists.
2. In foundry-local-api run `npm run build` after pulling the bootstrap that registers this extension (or set `FOUNDRY_API_EXTENSIONS` in that `.env` to a one-item JSON array containing the `file://` URL of `server/dist/dot-extension.js`).
3. Stop Foundry and start it again through `App/main.js`. A world reload does not restart the API process. The API log should include `AI-GM wake webhook enabled` and must not print the secret.
4. Confirm the queue tools are loaded: `foundry_list_ai_gm_deliveries` appears in the Local API MCP tool list, and its `hostCapability` is `wake`.

Verify one event with a local receiver:

```sh
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(q.headers.authorization);console.log(b);s.writeHead(204);s.end();});}).listen(8787,'127.0.0.1')"
```

Point `AI_DM_WAKE_WEBHOOK_URL` at `http://127.0.0.1:8787/wake`, restart Foundry, and move a player token once. Within about four seconds the receiver prints one JSON body and `Bearer <secret>`. A long drag in that window is still one request. `foundry_list_ai_gm_deliveries` then shows the item `acknowledged` with `acknowledgementId` `webhook:204`. HTTP 2xx is delivered. HTTP 408, 425, 429, and 5xx retry on the existing queue; other 4xx dead-letter.

Posted JSON uses this shape:

```json
{
  "type": "token_movement",
  "worldId": "world-id-or-null",
  "sceneId": "scene-id",
  "tokenId": "token-id",
  "actorId": "actor-id-or-null",
  "userId": "user-id",
  "userName": "name-or-null",
  "from": { "x": 0, "y": 0, "elevation": 0 },
  "to": { "x": 20, "y": 5, "elevation": 1 },
  "path": [
    { "x": 0, "y": 0, "elevation": 0 },
    { "x": 20, "y": 5, "elevation": 1 }
  ],
  "sequence": 12,
  "cursor": "generation:12",
  "timestamp": "2026-10-31T02:52:00.000Z",
  "deliveryId": "ai-gm-…",
  "eventId": "last-event-id",
  "attempt": 1,
  "coalescedEventIds": ["first-event-id", "last-event-id"]
}
```

Chat adds `messageId` and `content`. Combat turns use `type: "combat_turn"` and add `combatId`, `round`, `turn`, and `combatantId`. `from` and `to` are null for those.

The official component loads from the OpenAI CDN and requires network access. Exact loopback browser hosts (`localhost`, `127.0.0.1`, `[::1]`) default to the `local-dev` key shown in the [official ChatKit quickstart](https://openai.github.io/chatkit-js/quickstart/). Other hosts require an accepted ChatKit domain key configured in Foundry under the GM-only ChatKit domain key setting (`chatKitDomainKey`) for the exact browser origin. A configured key always overrides the local default. Configuration and runtime failures appear in the panel. Automatic observations are optional and disabled by default (`automaticEventsEnabled`); enabling them does not assign the DM identity. Automatic retries of uncertain effects are forbidden. Setup commands describe installation; they do not authorize configuration, credentials, deployment or billable calls in an offline-only task.

## Programmatic entry point and transmitted context

Use the module's `game.modules.get("foundry-ai-dungeon-master").api.trigger({ prompt, context, requestId })` entry point. Calls target the same panel conversation. Supply a unique request ID for each intended observation; durable repeated IDs are refused and per-world turns serialize. Optional validated automatic observation hints accompany keyed Region entry, door opening and completed player turns. They are data, never game execution authority. Pending automatic timers/queued requests cancel on panel cancellation, disable, disconnect or world/canvas changes. See [trigger contracts](docs/solo-dm-triggers.md).

Browser hints are limited to scene ID/name, controlled token IDs/actor IDs, target token IDs, combat ID, round and turn; arrays are bounded. The server supplies authoritative context separately. Explicit canonical party references support verified off-scene actors; unresolved membership is reported rather than choosing arbitrary NPCs. Overview has its own 3000-UTF-8-byte/2000-character allocation; retrieval has six excerpts, forty lines each and 10000-character/UTF-8-byte excerpt limits. Source hashes and document/section visibility constrain narration. The permanent `solo-dm-v6` assignment treats resource/tool content as data. [Context](docs/solo-dm-phase2.md), [campaign authoring](docs/solo-dm-phase3.md), [discovery](docs/solo-dm-phase4.md) and [review panel](docs/solo-dm-panel.md) document the implemented contracts.

## Verification and evidence

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run check:manifest
chatkit-server/.venv/Scripts/python.exe -m unittest discover -s chatkit-server -p "test_*.py"
```

See the current [solo DM ledger](docs/solo-dm-ledger.md), [acceptance summary](docs/solo-dm-acceptance-summary.md) and [live runbook](docs/solo-dm-live-acceptance.md). Earlier [ChatKit audit](CHATKIT-AUDIT.md), [architecture evidence](CHATKIT-ARCHITECTURE.md) and [integration verification](CHATKIT-INTEGRATION.md) retain historical scope. Passing builds and controlled MCP/DOM/model fixtures do not prove loaded Foundry, live model compliance, actual hook behavior or private serving. No live fixtures, reloads, switching, billable model calls or deployment were authorized during this implementation.
