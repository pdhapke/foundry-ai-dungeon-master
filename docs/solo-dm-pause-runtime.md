# Pause runtime inspection

October 1, 2026. Read-only inspection; no model call, pause mutation, reload,
fixture, credential creation or configuration change. Applicable ancestor
AGENTS.md files were checked from C:/ through the module; none exists.

## Observed live bridge

The existing server/.env API_KEY was parsed privately, without importing server
configuration (which can provision credentials). The existing authenticated MCP
transport connected to loopback 3939. Sanitized calls:

```json
{"operation":"tools/list","count":256}
{"name":"foundry_get_game_paused","inputSchema":{"type":"object","properties":{}}}
{"name":"foundry_set_game_paused","inputSchema":{"type":"object","properties":{"paused":{"type":"boolean"}},"required":["paused"]}}
{"operation":"tools/call","name":"foundry_get_game_paused","arguments":{},"result":{"paused":true}}
```

No setter was called. The live bridge therefore supports an explicit Boolean
pause setter and reports the game paused at inspection time. This is actual
Foundry-backed read evidence, not a mocked adapter result. It does not prove DM
grant admission or mutation execution/read-back.

The complete sanitized descriptor inventory is
[solo-dm-runtime-tools.json](solo-dm-runtime-tools.json). It records capture time,
names, input/output schemas and annotations only. Missing effect annotations
must not be interpreted as permission. Reproduction uses
[inspect-pause-runtime.mjs](../scripts/inspect-pause-runtime.mjs); it reads existing
credentials privately, writes only that inventory, calls health/list/get, and
never imports provisioning configuration or executes a setter.

## Embedded conversation evidence

SQLite databases were opened with URI mode=ro. Three alternate chatkit.sqlite
paths contain no items; .runtime/ai-dungeon-master/chatkit.sqlite contains 10 user
messages, 12 assistant messages, six workflows, three hidden context items and
one SDK hidden context. Hidden context contents and authentication stores were
not printed.

The latest relevant saved conversation is thr_7ced4fc8:

| UTC timestamp | Saved evidence |
| --- | --- |
| 17:01:28.873587 | User asks to unpause |
| 17:01:55.475744 | Assistant: “I can’t unpause Foundry with the currently available controls.” |
| 17:02:24.101436 | Reasoning workflow; no recorded tasks/tool calls |
| 17:02:41.379873 | Assistant: “I checked it twice, but this connection currently exposes only **read-only Foundry state tools**; no pause/unpause control is available” |

Earlier saved requests at 08:58 and 14:45–14:47 UTC also received unavailable
pause-control answers. These quotations are narration evidence, not evidence of
successful tools/list, search, schema loading or execution. The latest user
follow-up explicitly asks the assistant to query MCP tools.

The operations database has zero tool_searches, zero loaded_tool_definitions,
zero tool_executions and zero chatkit_native_actions, alongside four legacy
ai_dm_runs and six chatkit_turns. No actual discovery arguments/results or pause
execution receipt is recoverable from these records. Current ChatKit catalog
sessions keep discovery grants in memory; absence of legacy SQL rows does not
prove that discovery was never called. Saved workflow items contain reasoning
summaries only. No runtime trace/log files were found under .runtime. The claim
“checked it twice” cannot be independently corroborated from persisted history.

## Running build versus files

Loopback health responses were HTTP 200:

```json
{"port":3939,"status":"ok","version":"0.1.0"}
{"port":3940,"status":"ready","module":"foundry-ai-dungeon-master","version":"0.1.0"}
{"port":3941,"status":"ready"}
```

These endpoints expose no commit/build hash or loaded prompt version. They prove
availability, not that the newest files are loaded. The inspected built
server/dist/chatkit/catalog-tools.js admits six read projections, semantic dice
and private-note proposals; it lacks both pause descriptors. New source being
implemented concurrently already adds foundry_get_game_paused and a reviewed
setter; current dm_prompt.py declares solo-dm-v4. Source changes do not update a
running Python import or Node module cache automatically.

The current app.py source has one Agent/Runner loop and 12 wrappers when readRun
is available: scene/actor reads, campaign search/source validation/read/propose/
proposal status, tool_search/load/execute, dice and private-note proposal. With
no readRun it exposes no wrappers. Model selection is supplied by the gateway
per request, rather than hardcoded in that Agent. Existing server/.env contains
no OPENAI_MODEL or AI_DM_MODEL entry. The active conversation's actual selected
model and process-loaded wrapper/prompt identity were not recoverable through
the public health contract or persisted message records.

Windows process command-line inspection returned Access denied; listener-to-
process attribution was unavailable in this sandbox. Ordinary process start
times cannot establish which process owns these services. No escalation or
reload was attempted. No browser run capability was extracted/reused and no
fake authorization was minted to probe the internal catalog endpoint.

## Acceptance status

The new optional ChatKitToolAudit observer closes the future evidence gap at the
authenticated internal adapter boundary. It records attempts and returned/
denied/error/cancelled/uncertain outcomes to the operational SQLite database.
Scope is bound to a genuine server-issued run; grants and run capabilities are
stored only as SHA-256 digests. Search terms are bounded/redacted, returned tool
IDs bounded, and selected tools/schema digests correlate scoped load and execute
records. Argument digests, semantic action IDs/status and verified Boolean pause
read-back are retained; GM documents, proposal bodies, raw schemas and headers
are omitted. Default retention is 2,000 records with scope-filtered pagination.
No public audit route exists. Observer failures cannot retry effects or change a
completed response. A recorded attempt without a final outcome indicates an
interrupted/unresolved call, rather than completed execution.

Offline checks: five audit tests plus nine adapter tests PASS; server typecheck
and focused lint PASS. A real temporary SQLite restart preserves records;
controlled HTTP tests cover internal authentication and failure isolation. These
checks do not prove a live embedded tool call. Root owns production observer
wiring and future loaded identity instrumentation.

PASS: actual authenticated bridge inventory and authoritative pause read.
BLOCKED/unperformed: loaded DM build identity, embedded-chat discovery call/
schema/grant evidence, actual setter execution and read-back. The old built
catalog's omission explains why raw bridge availability does not imply DM
availability, but the exact process-loaded catalog remains unverified.

After explicit approval for loading/reloading the reviewed build and a model-use
budget, the embedded composer must run a fresh unpause request: discover, load
read/set schemas, read true, grant an explicit false setter with expectedPaused,
execute once, independently read false and report a verified receipt. Already-
false must be a read-confirmed no-op. Record actual call arguments/results and
loaded identity; narration alone cannot pass this gate. Restore fixture state
only if separately authorized. Broader inventory coverage is audited in the
capability coverage document; it must not be inferred from 256 raw descriptors.
