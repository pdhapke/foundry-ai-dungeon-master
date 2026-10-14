# Independent permanent-prompt subtask validation — October 1, 2026

Offline prompt/wiring subtask: **PASS**. This is not a full Phase 3 authoring or live model-behavior gate.

Read dm_prompt.py, test_prompt.py and the existing app.py builder/respond/action paths. DM_PROMPT_VERSION and the prompt's embedded version both identify solo-dm-v3. The assignment is static server-owned text, passed as Agent instructions for every build. Setup, preparation and play retain the same solo-DM identity; no mode/button is responsible for it. Application action stores an explicitly untrusted request/hint and delegates to respond, which is also the typed-message path. There is one production Runner.run_streamed call and no added nested model runner.

Policy covers player agency, system/version uncertainty, missing/partial overview and unresolved party, bounded source retrieval/hashes, legacy/stale context, data-vs-instructions precedence, spoiler narration flags, relevant trusted tool discovery with grants, revocation/uncertainty and no raw MCP bypass. Draft/canon distinction requires exact authenticated human review, explicitly forbids model-created approvals and requires verified completed persistence receipts. Private storage/tool unavailability yields an unsaved conversation draft rather than a success claim.

Independently ran chatkit-server/.venv/Scripts/python.exe -m unittest discover -s chatkit-server -p test_*.py: **16 passed, zero failed**. Two new tests inspect the static assignment and shared loop wiring; existing adapter/store tests remain passing. These checks verify policy presence and code structure, not a real model's resistance to adversarial instructions or a controlled authoring conversation.

Current build_agent still exposes six fixed tools, so campaign proposal and discovery instructions correctly include unavailable-tool fallback; actual adapter exposure belongs to the subsequent implementation. Tool descriptions and unsupported HP/door/inventory text must be reconciled if later phases enable those effects. The private-session-note policy is retained and still requires its authenticated review flow.

Changed path: this report only. Implementation changes: none. Model calls, live fixtures, reloads, credentials and deployment changes: none. Next gate: independent complete Phase 3 authoring validation after tool wiring; separately approved live model acceptance remains unperformed.
