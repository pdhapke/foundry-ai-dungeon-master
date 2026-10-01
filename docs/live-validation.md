# Live validation evidence

Validated on 2026-09-29 against Foundry v14 build 368 in the disposable `mcp-test` world:

- Foundry refreshed its package inventory and discovered **AI Dungeon Master 0.1.0** as a third,
  separate module.
- The module activated without changing `foundry-local-api` and added an **AI Dungeon Master**
  Scene-control button.
- The button opened the Foundry v14 application with current Scene/combat chips, transcript, status,
  prompt composer, and the required product name.
- With no AI Dungeon Master server available, the window reported a disconnected server
  and disabled prompt submission. This is the expected fail-closed state; no model call or campaign
  mutation occurred.
- An earlier compiled-server-only smoke check returned HTTP 503 without provider credentials. That
  historical check predates the process-tree identity broker and is not evidence for the current
  automatic authentication flow; current acceptance must use normal Foundry startup below.
- A stale zero-byte Foundry restart lock was preserved as
  `Data/Config/options.json.lock.stale-20260929-150553` before the disposable world was started.
- After the smoke test, a second restart lock was preserved as
  `Data/Config/options.json.lock.stale-20260929-151519`, and Foundry was restored to the originally
  active `izzy-campaign` world. The AI Dungeon Master module was not enabled in that canonical world.

No direct-prompt completion or paid/live OpenAI claim is recorded. Deterministic mocks, durable records, request-shape inspection, and existing redacted logs must be exhausted before any live inference. A real request requires explicit user approval at action time. The approval request must state the selected model, that ChatGPT plan usage or credits may be consumed, the exact minimal non-campaign prompt, and that exactly one request will be made. Approval for investigation or process control is not approval for inference.

The remaining live runbook is:

1. Start Foundry normally and confirm its companion services start in the same process tree.
2. Verify `/health`, open the AI Dungeon Master window as a signed-in GM, and confirm it connects automatically.
3. Confirm the eligible catalog and authoritative selected model survive a browser refresh. Confirm
   authorization/model failure disables GM inference and does not expose model controls to players.
4. After obtaining the explicit approval described above, submit exactly one minimal private prompt.
   Verify the exact selected slug reached `/v1/responses`, the stream ended in `response.completed`,
   output was delivered once, and no automatic retry or duplicate request occurred.
5. Verify safe terminal failures preserve only bounded GM diagnostics, clear partial browser output,
   and do not offer a one-click retry. Never record raw provider bodies, prompt text, campaign context,
   credentials, authorization headers, cookies, email addresses, or signing material.
6. Verify a mocked OAuth/model/Responses `401` or `403` clears persisted authorization, selection,
   and browser readiness. Refresh the browser and confirm durable terminal run state replaces stale
   pending state.
7. Verify a player cannot choose table/selected-user delivery, cancel another player's run, propose
   an undiscovered tool, or receive GM diagnostics.
8. Inspect live catalog counts and quarantine counts; do not enable automatic events until this direct
   path passes.
9. Keep movement disabled regardless of the result.
