# Phase 1 completion implementation evidence — 2026-10-02

Gate: implementation tests PASS; independent validation pending; live/manual acceptance BLOCKED pending user prerequisites and bounded inference approval.

## Inventory and ownership
Read C:/dev/FoundryVtt/REPOSITORY.md before edits. No nested AGENTS.md/REPOSITORY.md was returned by module search. Parent Git status contained pre-existing modified/deleted campaign material and dirty child repositories. AI module already contained modified app.py, dm_prompt.py, test_app.py, TypeScript/frontend artifacts, and many untracked reports/tests/services. These were preserved; no reset, restart, process launch, credential changes, network/model request, or live-world mutation was performed.

Owned edits: chatkit-server/app.py, new chatkit-server/test_routine_completion.py, this report and accompanying test output logs. Gateway/parser changes belong to the context worker.

## Completion contract
The authenticated loopback gateway emits x-chatkit-completion containing base64 JSON {version:1, toolName, arguments}. Strict complete-command parsing resolves only explicit IDs and requested values; labels, automatic/custom actions, compound instructions, retrieval and narration stay on the ordinary path. Python rejects malformed/oversized contracts, restricts tool names, validates exact arguments against the installed SDK tool JSON schema, and compares the actual tool arguments without coercing strings or booleans.

Eligible types: pause, door, movement/explicit teleport, absolute HP, condition, actor roll, dice roll, initiative and combat advancement. Current explicit-ID grammar is in server/src/chatkit/routine-completion.ts. Ordinary label-based commands are deliberately not claimed as one-request complete.

Finalization uses the SDK ToolsToFinalOutputResult callback, never global stop_on_first_tool. It requires exactly one model request, exactly one executed tool, the contract's tool/arguments, confirmed world-scoped receipt, supported core-actions-v1 schema, exact receipt action, matching requested observed state, factual summary, and prior durable exchange/receipt persistence. Integral JSON numbers compare equally across SDK float conversion; booleans remain distinct. Receipt identity conflicts fail reconciliation rather than overwrite conflicting history.

Existing hooks persist full function_call/function_call_output pairs as one HiddenContextItem before storing/emitting the factual AssistantMessageItem. First summary is delivered during tool completion; SDK finalization preserves normal output protocol. Existing converter reconstructs the complete exchange for the next turn. Cancellation during delivery leaves stored exchange/summary; reconnect replay avoids duplicate summaries. Failed/uncertain outcomes never qualify. Additional calls or a second model request permanently exclude that run from early completion.

## Installed SDK inspection
Installed dependencies: openai-agents 0.22.3 and openai-chatkit 1.6.5. Inspected agents/agent.py ToolsToFinalOutputResult and callable tool_use_behavior contract, and run_internal/tool_execution.py hook ordering. Fake Model objects drive installed Runner.run_streamed plus ChatKit stream_agent_response; they do not replace SDK loop machinery or call a provider.

## Tests
Commands run using chatkit-server/.venv/Scripts/python.exe:

- -m unittest discover -s chatkit-server -p test_routine_completion.py -q: 4 tests PASS, including nine positive tool types, five receipt mismatch outcomes, no-contract continuation, retrieval-first continuation, strict header decoding.
- -m unittest discover -s chatkit-server -p test_routine_speed_independent.py -q: existing 5 tests PASS (sole pause, compound/uncertain/failure continuation, cancellation after persistence, reconnect/replay identity conflict, next SDK turn with stored protocol, malformed receipt, historical evidence boundaries).
- -m unittest discover -s chatkit-server -q: 38 tests PASS; no baseline failures observed. Independent validator may add tests after this capture.

Detailed outputs: performance-completion-test-output.txt and performance-completion-all-tests.txt. Fake-model timings are test execution timings, not measured live command latency or performance distributions.

## Manual checkpoint boundary
Source changes need manual server-stack reload before they can be live accepted: the already-running Python process retains the old app.py code; Node gateway/parser changes also require user-managed restart. Follow the orchestrator's exact manual steps, then verify loaded manifest/codeDigest/prompt/policy identity. No service lifecycle action was taken by this worker.

A targeted frontend reload, if needed, must use the discovered authenticated remote-reload schema and intended opted-in client only; it does not reload Python/Node. Actual embedded-chat pause, door, movement, HP, roll and combat-advance acceptance remains pending bounded paid/model-backed request approval, reversible fixtures, action/receipt/final timing, and the user's mandatory evaluation. Phase 3 and broader combat workflows remain disabled/unmodified by this worker.

## One-turn manual acceptance budget
The user-approved acceptance session can temporarily set AI_DM_CHATKIT_MAX_TURNS=1 in the AI module server/.env. Node config.ts loads that file with dotenv, then Python child receives ...process.env. Existing launcher environment wins over dotenv; verify Python /health maxModelTurns=1 after the user manually restarts the stack. This health field is nonsecret and reflects the loaded process environment. Remove the temporary line or restore its previous value after testing, then perform a user-managed restart to restore ordinary continuation.

Installed-SDK tests with the environment limit set to 1 prove that an eligible confirmed command finishes normally with one request and a no-contract command reaches MaxTurnsExceeded before a second model request. Existing OpenAI client max_retries=0 prohibits transport retries. Six single-message acceptance prompts can therefore issue at most six model requests, provided there are no extra submits, reconnect re-submits, automatic triggers or other users' inference. This is a per-turn limit, not a global account quota; any extra request still requires prior approved remaining budget. Do not misrepresent the turn-limit error as command failure if a durable confirmed receipt already exists.

Updated routine completion suite: 6 tests PASS, 6.191 seconds. Fixed test fixture pollution discovered by the independent validator by deep-copying input cases before applying negative-case mutations.
Latest combined Python discovery after independent-validator additions and budget assurance: 57 tests PASS in 36.100 seconds; no baseline failures observed. Captured in performance-completion-all-tests.txt.
