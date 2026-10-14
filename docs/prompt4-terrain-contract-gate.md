# Terrain cross-seam contract gate

PASS offline: one new integrated terrain gate plus ten existing tests registered by the reused native perception fixture (11 total). No production changes, campaign writes, live client requests, builds or model calls were performed.

`server/src/chatkit/prompt4-terrain-contract.test.ts` creates a disposable campaign source and uses the actual `WorldCampaignContext`, authenticated `ChatKitReadTools` adapter and native perception fixture through mocked MCP transport. It passes the real typed adapter output across the language boundary into configured Python, invokes the actual `FoundryChatKit.action`, validates/project facts and persists/loads the separate safe store. Model execution is patched to throw if invoked.

The exact approved fixture sentence is “A section of corridor floor is visible here.” The visible exact point produces that sentence alone, including safe-store reconnect readback. Private campaign visibility, hidden/uncertain query point, campaign source changes during native await, asynchronous client generation change, and second-read native/source revision drift omit the sentence. Private campaign sections and injected raw retrieval sentinel do not reach output. Reconnect under another client cannot load the approved stored receipt. Threat/noticing/trap/unobserved area remain unknown.

This validates reusable production plumbing without approving a real campaign fact or asserting live visibility. The temporary fixture describes a point at x400/y500/elevation0 in a fictional scene. Actual original-scene coordinates, current player identity/readiness, human approval of the localized public fact, one explicit model-free panel request, actual canvas comparison and mandatory player feedback remain required. No whole-scene or terrain-absence claim is introduced.

Command: `node --import tsx --test src/chatkit/prompt4-terrain-contract.test.ts` from AI server; configured `.venv/Scripts/python.exe` is used for the cross-language action/store check. Final result11 passed/0 failed.
