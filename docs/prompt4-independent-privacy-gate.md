# Independent privacy gate

Independent validator reviewed current `chatkit-server/app.py` and `player_observation.py`, without modifying them, and supplied separate adversarial fixtures in `test_prompt4_privacy_independent.py`. No inference, live Foundry changes, service operations or provider settings changes.

Result: **10 independent offline tests passed** using `.venv/Scripts/python.exe -m unittest test_prompt4_privacy_independent -v` from `chatkit-server`. Log: `prompt4-independent-privacy-tests.log`. These are offline integration tests with a mocked authenticated adapter response, not embedded-chat or browser observations.

Verified behavior:

- Hidden trap coordinates, secret door/monster labels, private rationale/journals, malicious retrieval instructions, cached/historical secrets and injected observation auxiliary fields cannot enter the deterministic output projection.
- Explicit failed envelopes, malformed error codes, unsupported/unavailable/stale responses and boolean render counters fail closed without exposing diagnostic prose.
- Player action payload rejects GM context, prompt, history, reveal and retrieval fields; world mismatch rejects.
- Real `FoundryChatKit.action` does not invoke `Runner.run_streamed` or `ReceiptHistoryConverter.to_agent_input` even when its context contains GM secrets and provider fields. It writes only safe assistant text to the player thread.
- Existing historical GM private items/tool-pair evidence prevents enrollment into the player lane; original private item remains intact.
- A second asynchronous observation with changed world/player/browser/scene/token cannot publish readiness; thread audience cannot change on reconnect.
- Safe-store retrieval is scoped by world, scene, player, browser and token. Ordinary GM inference/reconstruction is denied on the player thread.

Audit found two defects while the worker was editing: safe-store audience initially omitted scene and a failed adapter envelope could be interpreted as its raw complete report. Reported to the implementation worker immediately; current implementation fixes both and the independent tests now pass. Also independently checked strict zero render-counter typing and malformed issue-code robustness after their repairs.

Scope and remaining limits:

The strict lane is an explicit deterministic player-observation custom action, with no model input or natural prose narrator. Its success text says perception is ready and descriptive surroundings remain unsupported; it supplies no threat/noticing/being-noticed/trap/reveal result. This therefore proves secrecy of this narrow output lane, not descriptive weekend narration acceptance. There is no extra model pass or inference usage.

Ordinary GM chats retain their existing GM context/retrieval/transcript and possible unrestricted narration. They have no strict player secrecy guarantee and must not be relabeled as safe player output. Private adjudication stays in the original private lane; validation here confirms its historical evidence was not copied or deleted, while complete normal tool-pair preservation relies on the existing protocol-history regressions/root full-suite gate.

The safe output store saves approved receipts separately, but ChatKit thread ownership is still authenticated world/GM ownership. Actual player frontend delivery, direct player access/authorization, current loaded Python/Node identities, scene cleanup, and browser render were not exercised. Reconnect tests prove store segregation and action audience checks offline; they do not imply that an old ready receipt is a fresh observation after the world changes. Readiness is a request-local receipt, never permission for later mutations. This lane has no mutation APIs and the tests confirm no model path, so stale work cannot issue a delayed action through this path.

Independent privacy gate: **PASS narrow deterministic lane offline**, **BLOCKED/UNPROVEN live descriptive narration and intended-player delivery**, **UNSUPPORTED semantic surroundings/reveals/threat/trap narration**. Manual weekend acceptance remains required.
