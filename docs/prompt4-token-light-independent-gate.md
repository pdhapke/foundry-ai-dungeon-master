# Token light independent gate

PASS for bounded offline implementation and installed API review. No live token was edited, services restarted, model invoked, or build performed by this gate. Runtime/browser light rendering and player visibility remain untested.

Reviewed shared action types, native session/core handling, dedicated server endpoint, automatic MCP registration and existing AI/Python scope. `foundry_set_token_light` delegates to the same confirmed core mutation lane as `token.light`: exact GM/world authority, shared ordering, stable request deduplication, connection-generation checks, authoritative state receipt and shared uncertainty fencing. Replayed changed arguments or connection generations cannot confirm a new mutation. Descriptor registration exposes the dedicated endpoint without new AI/Python tools; the AI typed core schema intentionally remains unchanged.

Installed Foundry evidence:

- `App/common/documents/token.mjs:90` defines token light as `EmbeddedDataField(LightData)`.
- `App/common/data/fields.mjs:407` returns no value on successful validation and a failure object on non-strict failure. The implementation checks this correctly; missing native APIs fail closed.
- `App/common/data/data.mjs:49` and `:52` define radius step 0.01. `fields.mjs:1517` rounds native numbers; ColorField casts through canonical CSS; AlphaField has bounds 0..1 without a step. EmbeddedDataField invokes model joint validation.

Independent review found an accepted-input/readback mismatch: subprecision radii and uppercase colors could mutate successfully after native normalization, then be rejected as an uncertain receipt by the server. This was repaired before the gate passed: both dedicated and core parsed schemas now reject non-0.01 radius precision before dispatch and canonicalize hex colors to lowercase. Alpha precision is preserved. The server retains exact canonical requested-field receipt equality rather than accepting arbitrary finite values.

The native operation clones current full light data, merges only approved bright/dim/color/alpha fields, cleans and validates against the installed native schema, and updates only `light`. Omitted animation, angle, darkness and other light fields survive the patch. Sight, detection modes, actor linkage, hidden state and other token settings are not included in the update. Full nested light state protects expected-state and postwrite comparisons, including preserved-field drift. Changed world/authority during asynchronous execution is uncertain and fences later requests.

Independent execution: eight native focused tests passed (five implementation regressions plus three independent tests for revoked GM, missing native validation and nested animation readback drift). Ten server/core focused tests passed, covering schema bounds, canonical precision/color behavior, authorization, native refusal, cross-entry deduplication, readback mismatch, generation changes and uncertainty fencing. Test fixtures mock the document/bridge APIs; installed source inspection verifies contracts but is not a live rendering claim.

A confirmed light receipt proves stored token light state, not what any player can see. Walls, fog, vision mode and native perception still apply. Narration must use a fresh bound player observation after revision change; no receipt should fabricate illuminated terrain or disclosed threats. No routine inference/tool scope was expanded. Manual runtime acceptance remains required before claiming actual token-light rendering or resulting player visibility.
