# Independent ChatKit QA

Date: 2026-09-30, America/Chicago. Final outcome: core genuine Foundry ChatKit milestone verified live after evidence-driven CORS and lifecycle corrections; see final acceptance below. Earlier blocked/failing observations are retained as diagnostic evidence.

## Actual runtime evidence

- Initially Chrome navigation to http://localhost:30000 returned ERR_CONNECTION_REFUSED. Configured Foundry port is 30000.
- Started the existing normal launcher using Node `App/main.js --dataPath=C:/dev/FoundryVtt/Data`, working directory `App`, hidden background window. Process ID 14900. Startup output stored in ignored `C:/dev/FoundryVtt/tmp/chatkit-qa-foundry.out.log` and `.err.log`; values were not copied into this report.
- Chrome subsequently displayed http://localhost:30000/auth, Foundry Version 14 Build 368, **Administrator Access Required**, and **There is not currently an active game on this server**. No existing authenticated GM browser session was available. No password was guessed, reset, or created. No game records were edited.
- `Invoke-WebRequest` GET http://127.0.0.1:3939/health, :3940/health, and :3941/health each returned HTTP 200 after normal launcher startup. This verifies preserved Local API, Node companion and Python sidecar startup together in the real process tree.
- POST http://127.0.0.1:3940/chatkit with `{"type":"threads.list","params":{}}` and no enrollment headers returned HTTP 401. This is a real authentication rejection, not a mock.
- Existing local `server/.env` checked by variable presence only: OPENAI_API_KEY and OPENAI_MODEL absent. No credentials were printed. Integration separately confirmed explicit API fallback disabled. Domain-key presence cannot be verified until a GM world is loaded.
- At user request, stopped only QA-owned Foundry PID 14900 and its child process tree; all four runtime ports (30000, 3939, 3940, 3941) then refused connections. User will restart and log in. Health passes do not establish inference or MCP tool execution.

## Independent rerun commands and results

Run from `C:/dev/FoundryVtt/Data/Data/modules/foundry-ai-dungeon-master`:

- `npm test`: exit 0. 140 passing deterministic tests: bootstrap 7, shared 9, server 101, frontend 23. Existing MCP catalog compatibility and injected MCP adapter tests pass; these are local/injected tests, not authenticated live MCP tool calls.
- From `chatkit-server`, `./.venv/Scripts/python.exe -m unittest -v test_app`: exit 0, 7 passing tests. Official SDK/store and FastAPI are real; model inference and held stream producers are mocked.

Coverage observed: SDK manual message and custom action use one thread and preserve history/context; durable owner-scoped store; cross-user denial; action payload allowlist; duplicate action rejection; native SSE forwarding; overlapping stream rejection; disconnect cancellation and guard release; Agents-run cancellation; mounted mock component close/reopen/listener cleanup and stream abort; expired/player/origin auth denial; unavailable-service error redaction; browser enrollment headers do not persist credentials.

## Acceptance limits / exact remaining prerequisites

| Requirement                                           | Evidence status                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Embedded panel mounts in real Foundry                 | Blocked by administrator/world login gate                                                                                                                                                        |
| Manual real incremental assistant response            | Not verified; no eligible configured API credential/model                                                                                                                                        |
| Button/event real response, same conversation/context | Implemented and mock-tested; not verified live                                                                                                                                                   |
| Duplicate/busy/close/reopen/cancel/network errors     | Deterministic mocked coverage passes; actual component runtime not verified                                                                                                                      |
| Unauthorized gateway request                          | Verified live HTTP 401                                                                                                                                                                           |
| Client secrets                                        | Static focused search of new panel/context code found no API-key references or console logging; mock gateway tests verify credential confinement; real authenticated browser traffic unavailable |
| Preserved MCP                                         | Actual Local API health 200; existing compatibility tests pass; live game tools blocked by no launched/authenticated world                                                                       |

User must authenticate existing Foundry administrator, launch the intended world, and join as GM. Configure an accepted public ChatKit domain key for exact origin http://localhost:30000 and eligible server-only OpenAI API credential/model following README; do not put an API key in browser settings. These prerequisites must be fulfilled before recording end-to-end streaming acceptance. No billing changes, credential creation, push, or deployment performed.

## Resumed GM runtime QA (user restarted and logged in)

The user subsequently logged in as Gamemaster [GM] at `http://localhost:30000/game`. Exact ChatKit registration origin: `http://localhost:30000`.

- Opened the actual scene-control **AI Dungeon Master** button. One embedded ApplicationV2 panel rendered with context disclosure and **Describe current game context** / **Cancel response** buttons.
- Actual visible failure message: **Set the ChatKit domain key in module settings for this Foundry browser origin.** No composer was mounted because configuration was absent. Screenshot captured inline by independent QA CUA `getScreenshot` call showing the panel and Foundry scene.
- Clicked context button and Cancel response, closed panel, reopened through scene control: no crash, no duplicate window, same explicit configuration error. This verifies runtime lifecycle/error display only; no active stream existed to test cancellation.
- Verified exact UI path: **Settings > Game Settings > AI Dungeon Master > ChatKit domain key**. Field was empty. Server URL shown as `ws://127.0.0.1:3940/ws`. No setting value was changed or saved.
- Rechecked actual health endpoints 3939/3940/3941: all HTTP 200. Unauthenticated POST /chatkit still HTTP 401.
- Presence-only recheck of server/.env: OPENAI_API_KEY, OPENAI_MODEL, AI_DM_CHATKIT_AUTH, AI_DM_ENABLE_API_KEY_FALLBACK absent. Domain key absence is now confirmed directly in the GM settings UI.
- Attempted preserved read-only MCP-shared world-time endpoint verification using the existing Local API credential location; no FOUNDRY_API_KEY assignment present there, so no authenticated call was issued. Local API health and deterministic MCP compatibility tests remain passing; live MCP tool execution is not claimed.
- User-owned runtime was left running. No game documents, tokens, world settings, credentials, or billing were modified.

Updated acceptance: actual panel mount and close/reopen error state verified live. Manual streaming, context-trigger response, continuity, active cancellation/network-error behavior remain blocked by absent domain key and eligible server API configuration. Earlier administrator gate is resolved.

## Existing ChatGPT authorization route QA

Reloaded actual GM browser frontend only. Auth section renders before missing-domain-key check: Continue with ChatGPT, Refresh status, Sign out, and eligible model dropdown. Initial dropdown displayed GPT-6-Astra while status requested model selection; Refresh preserved that mismatch (reported to orchestrator). Continue clicked once produced no new tab while existing account was connected. Selecting available GPT-5.6-Sol changed status to **ChatGPT model available: gpt-5.6-sol. ChatKit also needs its registered domain key.** Thus absence of API key does not prove existing OAuth is missing; eligible legacy provider state exists. No new login, consent, credential creation or billing change performed. This is model readiness UI, not proven inference.

Latest independent `chatkit-server/.venv/Scripts/python.exe -m unittest -v test_app`: 8 tests passed, including actual serialized plan request fields through mocked outbound HTTP; no real OpenAI request.

Official localhost development investigation: https://openai.github.io/chatkit-js/quickstart/ explicitly shows `domainKey: 'local-dev'` with localhost API. https://github.com/openai/chatkit-js/issues/76 OpenAI collaborator says domain verification disabled in testing environments and enforced staging/production. Reported evidence for frontend localhost-scoped development default; it must be tested against actual CDN, not presumed to bypass nonlocal registration.

### Actual localhost CDN validation

After localhost-only `local-dev` default patch/build, reloaded GM browser and opened panel. Official CDN ChatKit iframe rendered heading, New chat/history controls, editable Message the AI textbox and Send message. Console explicitly reported **Domain verification skipped for http://localhost:30000 - this check is required in production.** Development domain-key default is thus verified against actual CDN. No model inference attempted before user restart of latest backend `store:false` changes.

Bootstrap status later showed Failed to fetch. OPTIONS /chatkit with real origin and all enrollment headers returned 204 and correct allow-origin/allow-headers. Focused console showed two unrelated-to-CDN controller callback TypeErrors: reading game.settings.get before game.settings readiness; reported to orchestrator for correction. During diagnosis user tab changed to /no and ERR_CONNECTION_REFUSED, indicating runtime transition; root notified and QA did not interfere with user-controlled restart.

## First live manual attempt after backend restart

User confirmed Foundry online; actual GM ChatKit composer and selected existing ChatGPT model ready. Submitted one short continuity marker prompt through official iframe composer. Within roughly one second, iframe displayed **There was an error while generating the assistant's response.** No assistant delta or persisted user message observed; outer panel said Ready. Focused console had only unrelated Foundry V1 warning and valid localhost domain-skip warning. All three runtime SQLite stores contained zero threads (read-only counts), indicating failure before SDK thread persistence. Reported immediately to backend owner/orchestrator; no repeated model requests issued before diagnosis. Live inference remains failed/unverified.

Context bootstrap follow-up: clicked actual Describe current game context, no response/delta; second click was rejected with **A response is already running. Cancel it or wait for completion.** Cancel displayed **Response cancelled.** This verifies live overlap denial and pending-request cancellation UI only, not Agents stream cancellation. Backend diagnosis in progress; further inference attempts held until evidence-based fix.

### Root cause pinned with actual CDN request shape

Latest restarted diagnostics before panel mount: `{requests:0,stage:idle,errorCode:null,upstreamStatus:null}`. History-only mount generated repeated gateway **preflight** requests and no POST/upstream; component failed to fetch. Temporary credential-free frontend debug serialized method/path/header names: POST `/chatkit`; `accept-language`, **`chatkit-frame-instance-id`**, `content-type`, and four frozen enrollment headers. Gateway CORS omitted official CDN non-safelisted `chatkit-frame-instance-id`, explaining browser refusal before thread persistence. Exact observed header sent to backend owner for narrow allowlist correction. No model call attempted while this bootstrap failure persisted.

### Real model and continuity evidence after CORS correction

History bootstrap now reached `stage:completed,upstreamStatus:200`. Submitted marker prompt through official iframe composer; received genuine assistant **Hello! Silver lantern.** A second twelve-sentence request retained silver lantern from prior manual message. Observed Receiving response then completed replies; those short responses completed between snapshots, so incremental text not yet proven.

Context button revealed a lifecycle failure: unconditional force rerender detached/recreated iframe, cleared manual history, stalled Preparing response and created a second empty thread. Read-only DB count: 2 threads, one original thread with 5 items and one empty. Cancel recovered. Reported root, which fixed open/trigger to avoid rerender when live component exists. Testing that fix next; empty QA thread retained, no deletion.

## Final live acceptance (supersedes earlier blockers)

User restarted latest backend and logged in as GM; existing account authorization and selected gpt-5.6-sol used. No API key created or billing changed. Official localhost local-dev CDN verification passed.

| Requirement                        | Independent final result                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real manual chat                   | PASS: actual official iframe composer submitted prompt, real assistant replied Hello! Silver lantern.                                                                                                                                                                                                      |
| Incremental real streaming         | PASS: bounded forty-sentence request; consecutive actual DOM snapshots grew 3993→4084→4117→4210→4374→4487→4673→5413 characters while Receiving response and Stop response present, followed by completed response. No mocked server involved.                                                              |
| Foundry button initiates response  | PASS: Describe current game context produced real current-scene description without manual typing.                                                                                                                                                                                                         |
| Same intended conversation/context | PASS: original thread thr_850c198a persisted; context button preserved manual history after lifecycle fix. Later manual response remembered both silver lantern and IZZY \| 03 Sargauth Level. Read-only DB final count15 items on that thread; empty QA failure thread retained.                          |
| Close/reopen                       | PASS live: after cancellation, reopened one panel with same persisted history and working composer.                                                                                                                                                                                                        |
| Overlap/repeat while busy          | PASS live: context button during active manual request rejected with A response is already running. Cancel it or wait for completion. Exact requestId replay dedup remains deterministic/mock-tested, not exercised through arbitrary browser script.                                                      |
| Cancellation/recovery              | PASS live: cancelled long manual request before response text; displayed Response cancelled. Reopened and short real inference succeeded with remembered marker and scene. Agents upstream cancel behavior separately mock-tested.                                                                         |
| Authentication failures            | PASS live: unauthenticated POST /chatkit HTTP401. Player/current-role denial additionally deterministic/mock-tested; no separate player account login created.                                                                                                                                             |
| Network error                      | Actual CORS failure reproduced and corrected; Failed to fetch displayed; subsequent native history completed HTTP200. Deliberate server outage during live model not induced.                                                                                                                              |
| Credentials                        | Browser observations/debug contained no credential values; temporary request diagnostic logged only method/path/header names and was removed. Gateway confinement and no persistence assertions pass deterministic tests.                                                                                  |
| Preserved MCP                      | Successful native gateway requests validate current GM/world through preserved MCP integration: actual acceptance passed that required boundary. Local API health200. General MCP tools/catalog compatibility tested with injected mocks; no unrelated world mutation or broad MCP tool execution claimed. |

Final runtime left running under user ownership, panel open and ready. No game documents edited; only private QA conversation messages and one empty failed-remount conversation added. Exact CLI checks: npm test (140 passed initial independent run; subsequent integration reports latest counts), chatkit-server/.venv/Scripts/python.exe -m unittest -v test_app (8 latest passing including outbound request mocked), Invoke-RestMethod /health.chatkit stage inspection, unauthenticated Invoke-WebRequest POST /chatkit, and read-only SQLite counts. Actual browser evidence came from official composer/button interactions and repeated DOM/AX snapshots, not mock text.
