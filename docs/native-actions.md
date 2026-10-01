# Reviewed native actions (Phase 4)

The existing ChatKit Python model loop calls the authenticated Node run adapter. Node owns authorization, input validation, current-world checks, selected MCP invocation, proposal storage and execution. The administrative catalog is never attached to the model.

## Available actions

- **Automatic dice:** `foundry_roll_dice(action_id, formula)` evaluates a native Foundry Roll without posting to chat. Formulas are limited to 1–99 dice of 4/6/8/10/12/20/100 sides, with one optional integer modifier of at most three digits. No data substitutions, functions, macros or code are accepted.
- **Confirmed session journal:** `foundry_propose_session_note(action_id, title, text)` proposes one GM-private JournalEntry with a bounded plain-text page. HTML characters are escaped. Title is 1–120 characters; text is 1–4000. The UI displays the exact proposal text. No effect occurs until its original GM selects **Review native actions → Approve private session journal**. Reject has no effect.
- Actor HP, doors, inventory/item use, arbitrary document updates, shell and filesystem access are unavailable. The existing transaction endpoint's strict schema supports JournalEntry and Item, not Actor or Scene; this module deliberately avoids general CRUD fallback.

## Approval and execution

Proposals bind the authenticated world, user, conversation, current scene, immutable exact input and a five-minute expiry. Node verifies current GM/world authorization and active scene before execution and re-preflights the exact native transaction. A generated 16-character document ID and stable transaction correlation/idempotency ID remain unchanged after proposal creation. The native provider checks collision/permissions/schema and maintains its durable transaction/idempotency records.

`POST /chatkit/actions` uses the same Foundry session headers and origin restriction as chat. Body `{ "threadId": "..." }` returns the latest 12 owner-scoped actions. Body `{ "threadId": "...", "actionId": "...", "decision": "approve" | "reject" }` decides an existing exact note; it cannot replace its contents. Approval does not invoke a model or require model credentials. Review preserves the mounted chat frame.

Node persists pending, dispatching, completed, rejected and uncertain states in `chatkit_native_actions` in the existing operational SQLite database. A synchronous dispatch claim precedes any effect; concurrent deliveries and repeated approvals never send another effect. Reused IDs with changed inputs are refused. Timed-out, disconnected, cancelled, malformed-result or restarted dispatches become uncertain, with no automatic redispatch. Actual matching provider receipts alone permit completed status. The next ordinary message or custom action receives the latest receipts through the same authoritative context builder.

For an uncertain journal, inspect the recorded `transactionId` with the existing `foundry_get_transaction_status` operator tool and the actual Foundry journal before deciding on manual recovery. The model and chat approval endpoint cannot invoke recovery or bypass uncertainty. Do not repeat an uncertain effect under a new action ID. An uncertain dice result is also never rerolled automatically.

The native transaction promises strict verified compensation, not database isolation. A browser crash can require manual recovery; observed hooks cannot be undone. No broader mutation guarantees are claimed.

## Validation and launch

From the module root, run `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`. From `chatkit-server`, run `.venv/Scripts/python.exe -m unittest test_app`. Existing Foundry module startup launches the Node companion and Python backend as before; `module/dist/index.js` includes the review control. No additional environment variables are required.

All new action tests use a **mocked MCP provider**, including native dice results and journal transaction results. Real SQLite persistence/reopen, current authorization handling, cancellation deadlines, bounded inputs, exact manifest/receipt validation, concurrent approval, rejection/no-effect, stale scene, expiry, wrong world/thread, malformed arguments/results, and the mocked browser approval control are checked. Python tool dispatch is tested through the installed SDK without model inference. These are not live Foundry or model verification. No real campaign actor, journal or scene was mutated during implementation testing. Independent validation is required before the next phase; live Foundry/model acceptance remains a separate gate.
