# Phase 4 MCP bounded combat implementation

Prepared source only; no live acceptance, inference, fixtures or service lifecycle performed.

Ownership: MCP shared attack-actions contract, server endpoints/attack-actions.ts, module attack-actions.ts and new attack-sequences.ts, module import, focused fixtures. Start inventory: phase4-start-mcp-inventory.txt. Existing unrelated dirty changes preserved.

## Contract and native execution

attack-sequence-v1 / foundry_attack_sequence_confirmed / native attackSequenceConfirmed. Execute supplies 1–4 explicit step IDs and full actor/item/activity/token target IDs; resume supplies previous sequence request ID and one-use continuation ID. Authenticated exact live GM/world is checked before durable access, claim and native mutation. Native strict validation rejects extra properties, malformed IDs, modes and advantage before any ledger/resource/roll operation.

Native registered sequence holds Phase 3 shared world mutation lane for its entire operation; internal attack helpers never reacquire that lane. Existing server lane also orders sequence against core/pause/attack/damage. Explicit list is GM-authorized mechanics, not an inferred Multiattack feature/rules entitlement or action economy engine. Unreviewed native GM UI and external mutations remain outside this guarantee.

A private GM-only Journal ledger durably claims the immutable outer plan. Derived child IDs SHA256(JSON.stringify([original sequence request ID, step ID, roll|apply])) survive continuation. Roll/apply existing durable receipts retain structured native evidence. Exact delivery replay returns prior result; pending crash/uncertain state cannot roll, consume or apply again. Per-step receipt persistence is non-atomic and partial outcomes are reported.

A 1–8 second soft admission budget is checked between awaited native resource/roll/damage/application stages. In-flight native work cannot be interrupted; the existing bridge timeout can yield uncertainty. No later native stage executes once the deadline is observed. Clean between-step deadline partials have a one-use owner/world-bound ticket; resume uses cumulative immutable plan and compares current HP, positions, full source item/resource observations before continuing. Reaction, within-step timeout, native cancellation after spend and uncertain outcomes have no automatic continuation and require manual reconciliation.

## Installed dnd5e API and resources

Only reviewed dnd5e 6.0.3 is supported. No dedicated Multiattack sequence API was found. Native Activity.use({subsequentActions:false,create:false}, {configure:false}, {create:false}) consumes explicitly configured supported itemUses/activityUses before rollAttack, and no automatic follow-up roll is triggered. Spent snapshots verify the actual cost, native actor/item returned updates are read back, create/delete side effects reject. Native null/undefined use after consumption is uncertain with a pending ledger; no refund or retry occurs. Standalone attack endpoint retains resource rejection; only the private sequence workflow enables this native usage path.

Supported resource targets are numeric nonnegative constant costs on the source item/activity with no scaling/target redirection or combat-only recovery. Spell slots, activation counters, linked activity resources, concentration, templates, effects/behaviors, reaction activation, complex formulas and known automation combinations are explicitly unsupported before use. This is deliberately incomplete broader resource support. Native rollAttack alone handles ammunition/thrown quantity; retained ammunition and quantity readback are reported separately, avoiding double consumption.

Hit/miss, critical damage, damage types, resistance/immunity/vulnerability and temporary HP retain existing native attack and Actor.applyDamage workflow. Reach/range/cover/target legality remain explicit GM adjudication limitations. Reactions stop before damage; no model-selected reaction ticket is treated as human approval.

## Validation

Focused native sequence tests cover two hits, duplicate replay, resource-consuming miss, post-spend cancellation, clean partial continuation and delayed usage cutoff. Independent validator covers strict bridge validation, crash-pending recovery, HP/removed-target drift, activation rejection and clean cumulative resume. Native installed-method extraction tests are separate evidence, not live system rendering. Full offline gates PASS: MCP module 328 tests, server 527 tests, both typechecks, and shared/module/server builds. Logs: phase4-mcp-module-tests.log and phase4-mcp-server-tests.log. Independent final cross-family gate remains the parent validator report.

HTTP cancellation does not cancel native mechanics; the bridge currently has no native cancellation signal. This is a remaining acceptance limitation.

No latency improvement or embedded natural-language/player browser acceptance claimed. New compiled artifacts require manual server restart and targeted test-client reload, followed by startup and native build identity verification, before approved bounded live acceptance. No services have been changed by this worker.
