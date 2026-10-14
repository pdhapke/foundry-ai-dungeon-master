# Prompt 4 native audit and repair evidence

## Scope and supplied evidence

Worker inspected `phase5-independent-final-gate.md`, `phase5-secret-validation-diagnosis.json`, `phase5-second-validation-supported.json`, `phase5-extras-helper-report.md`, current schema validator, and installed Foundry 14.368 source. No AGENTS.md was found in the workspace recursive inventory. Historical reports are supplied evidence, not worker verification of current browser identity. No services, clients, world data, consent, fog or scene fixtures were changed by this worker.

## Reproduction and root causes

1. Wall secret-door validation: installed `App/common/documents/wall.mjs` builds NumberField choices as numeric-keyed label objects. Installed `App/common/data/fields.mjs` NumberField accepts `String(value) in choices`. Module `enumChoices` instead returned string `Object.keys`; shared portable checker compares `Object.is(choice,value)`. Thus numeric 2 fails the portable enum check despite the native validator allowing it. Same mechanism explains dir/ds/light/move/sight/sound failures; this is a schema conversion defect, not a demonstrated secret-door perception failure. The independent `c` native failure on a partial update was a separate missing coordinate candidate.

2. Additional owned token validation: installed `token.mjs` uses nullable ActorDeltaField; linked actors initialize no delta. Native cleaning preserves null. Our `applyPortableDefaults` walked every flattened child default, replacing a null parent with `{}` and inserting optional null name/img/type/ownership fields. Portable required validation then demanded missing delta._id/system/items/effects/flags. The resulting invented object exactly matches the saved report. This is a default projection defect, not a demonstrated multiple-source vision failure.

Model-free reproduction used the current shared `validateDiscoveredFields` with legacy descriptor shapes: numeric `door:2` plus `choices:Object.keys({0:'none',1:'door',2:'secret'})` produced INVALID_ENUM at door; default-materialized delta with only name/img/type/ownership produced REQUIRED at each of the five saved paths. No paid inference or live mutation was used. Regression fixtures model the installed NumberField object-choice/native validation semantics and nullable ActorDelta cleaner, covering valid and invalid values plus omitted/null delta.

## Repair and validation

Owned code: local-api `module/src/commands/schema-discovery.ts`, its test file, `scripts/generate-latency-build.mjs`, generated `module/src/latency-build.ts` and `module/dist/index.js`; additionally scoped `server/src/mcp/http-tool-client.ts` and its tests at root request.

Numeric object-backed NumberField choices now project numeric keys; StringField choices remain strings. Portable defaults no longer manufacture descendants under null/absent/nonobject schema nodes. Required descendant checks are omitted only beneath a native nullable null parent. Native field and joint validation remain active, invalid native deltas/enums still fail, no candidate persistence is introduced.

Commands (from local-api directory):

```text
node --import tsx --test module/src/commands/schema-discovery.test.ts
npm run typecheck --workspace=@foundry-local-api/module
npm run test --workspace=@foundry-local-api/module
node --import tsx --test server/src/mcp/http-tool-client.test.ts
npm run typecheck --workspace=@foundry-local-api/server
npm run build --workspace=@foundry-local-api/module
```

Results: focused native 16/16; native full 345/345 (log `prompt4-native-tests.txt`); native typecheck pass; HTTP forwarding 4/4; server typecheck pass; native build pass. Server was not built/restarted. MCP HTTP errors now preserve a bounded allowlisted `{error:{code,retryable}}` structured result so adapter callers can distinguish NOT_CONNECTED/TIMEOUT. No messages, details, IDs or arbitrary fields enter that structured result; existing textual error behavior remains for compatibility.

## Disk build identity and loaded scope

Prepared client marker: `93dafcb0ec5405fa463c88eb2c7d07d5ddceae0fe0b5b39c3dd8d5cc4f03a8c2`.

Prepared module/dist/index.js SHA256: `91ebcee4b546d4a6d49a5d5b5599c632fd0574a3f7daa23ee78d315b7515f2ef`.

Marker inputs now include bridge-client.ts, command-registry.ts, session-actions.ts, shared/protocol.ts, scene-render.ts, shared/scene-render.ts, **schema-discovery.ts and shared/schema-discovery.ts**. Previously schema changes did not change the perception marker. These are prepared disk artifacts only: no reload occurred and current browser marker remains unverified by this worker. Node startup native hashes remain historical after any later client-only reload.

## Live gate still required

Root independently validates changes, then secures a restoration snapshot and verifies exact opted-in player identity/ownership/consent before targeted reload. Re-run supported read-only Wall/Token schema probes first. If native errors persist, stop. A passing validator does not establish secret-door redaction, intended-player multiple-source rendering, authenticated adapter routing, or narration secrecy. Those remain distinct live gates under root orchestration, with no GM source substitution or synthesized visibility.

## Follow-up: native ownership mapping discovery

Root live setup stopped before its first mutation: Actor candidate native valid:true, but portable UNKNOWN_FIELD warnings at ownership.default and ownership.edtBL96Yu3058QAT. Saved evidence is `prompt4-live-fixture-ledger.json`, first validation, operations empty. This worker did not make the live request.

Installed `App/common/data/fields.mjs` DocumentOwnershipField extends ObjectField: native keys are default or valid 16-character document/user IDs, values are installed DOCUMENT_OWNERSHIP_LEVELS. This intentionally has no statically discovered user child schema. Portable unknown-field traversal descended the native map and mistakenly labeled legal map entries unknown. The narrow repair recognizes only native DocumentOwnershipField leaves with a native validate method, then excludes their descendant unknown warnings. Every native field/joint validation remains active; malformed native user IDs and invalid permission levels still reject. Unrelated unknown fields retain warnings. No ownership is removed, no permissive generic ObjectField suppression is added, and no native/warning gate is bypassed.

Regression covers actual intended player OWNER level and default NONE preservation, invalid IDs/levels/types rejected by native validator, unrelated unknown key warning, no persistence. Focused schema suite17/17; full native346/346 (`prompt4-native-ownership-tests.txt`); module typecheck and build pass. Only module validator/test and generated client marker/bundle changed. No reload, service restart, world mutation or setting change by this worker.

Final prepared ownership-repair marker: `ac495ff74c52bbb8624b5ea30d73191921612d0b7f72ef9b7945166bcde67e7e`; client bundle SHA256: `6fe2430703d95a581dd82be57317249bcc39541283768eb08d22fcef58464fd0`. Earlier 93daf marker/bundle above are historical prepared artifacts. This is a client-only source/build repair; root must targeted-reload exact intended GM/player, recheck loaded identity, independently verify untouched originals/archive the zero-operation old capture, then recapture fresh client connections before setup. Node/server startup marker remains historical and must not be substituted for current browser/native identity.
