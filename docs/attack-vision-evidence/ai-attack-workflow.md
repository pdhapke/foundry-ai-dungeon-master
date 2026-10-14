# AI attack and selected-player perception integration

Implementation: `attack-actions.ts` adds a durable, scope-checked authenticated service; `native-actions.ts` connects it to the existing Python read adapter and authenticated direct browser actions. The existing Python ChatKit loop, serialization, tool call/result persistence, authoritative receipt messages, MCP execution and permanent DM prompt remain in place.

Frozen protocol: attack-actions-v1. A roll identifies scene, attacker token, actor, item, native attack activity and one target token, plus explicit native advantage/options. Apply references the originating persisted attack requestId; it never rerolls. Attacks do not use invented bonuses or formulas. Installed dnd5e 6.0.3 sources were inspected at AttackActivity.rollAttack, ActivityMixin.rollDamage, Actor5e.calculateDamage and Actor5e.applyDamage. Native canceled application retains existing attack/damage evidence and does not imply the attack roll was canceled.

Every AI roll/application receives a stable explicit actionId. Scope includes world/user/thread. A durable pending claim precedes MCP execution. Same ID/content returns prior receipt; ID/content drift fails. Uncertain or pending attacks fence fresh attack IDs in the world. Native ledger uncertainty also shares the established routine mutation fence. The AI service validates protocol, world/user, correlation/request/action identity, source identifiers, originating roll ID, bounded native evidence and actual HP+temporary HP delta for applied damage. It does not reproduce system rules.

`foundry_roll_attack` rolls mechanics only. `foundry_apply_attack_damage` applies only prior scoped evidence and cannot supply a reaction ticket. Actual player decisions/reactions remain explicit. Review proposed actions shows the native decision message and a human button labeled 'Player decisions resolved; apply recorded damage'. Its authenticated direct request conveys the exact prior requestId/decisionId; model tool calls cannot manufacture this trusted provenance. Live authority is checked again. Effects, reaction mechanics and target changes must be resolved in Foundry before this explicit human continuation; stale/ambiguous outcomes stop. Unsupported resource-consuming/multiple-choice/system workflows remain explicit rather than pretending full automation.

Receipt summaries distinguish hit/miss/critical, attack evidence, damage rolled versus applied, HP and temporary HP before/after, and unresolved decisions. Confirmed mechanics display immediately via the established persisted receipt path. Optional narration and remaining steps continue separately. Source and mocked SDK tests do not prove live embedded-chat inference.

Zero-inference direct commands use the same service:

- `/ai-control attack SCENE ATTACKER_TOKEN ACTOR ITEM ACTIVITY TARGET_TOKEN [normal|advantage|disadvantage]`
- `/ai-control attack-apply PRIOR_ATTACK_REQUEST_ID`
- `/ai-control move SCENE TOKEN X Y` uses native walk semantics.
- `/ai-control teleport SCENE TOKEN X Y` requires explicit teleport intent.

Selected-character narration can call `foundry_read_token_perception` on demand. It requires the selected opted-in connected non-GM client and owned token. The adapter verifies world request authorization, exact scene/user/token and all native redaction markers, then exposes bounded player-visible IDs and native evidence status. It never falls back to GM canvas visibility. Ordinary native perception refresh does not invoke Python, a model or campaign retrieval. Solo-GM actual player rendering remains unavailable without a real player client.

Checks before final independent gate: full AI typecheck PASS; own attack-service and direct-command deterministic tests PASS (4); Python tests PASS (34 at final pass, including independent Python attack checks). The independent validator owns separate source/service/SDK checks and final gate. Parent owns live fixtures, normal restart, build identities, browser observation and cleanup. No inference or runtime restart was performed by this worker.

An editing encoding failure temporarily truncated app.py; its exact checkpoint source was reconstructed from recorded edits and verified SHA256 `ba3e4b0af911ae6e637bc906b5c3b900fc7db6d40e01dfb9bae598878629c409` before any phase-5 reapplication. Source writes now use atomic UTF-8 saves. No baseline code or unrelated changes were discarded.
