# Token light native action evidence

Added `token.light` to existing SessionAction/CoreAction union and existing session executor; no separate mutation path. Payload is `{kind,sceneId,targetId,light:{bright,dim,color?,alpha?}}`. Radii finite, nonnegative, bright<=dim<=10000; color #RRGGBB/null; alpha0..1. Unknown action/patch keys rejected. Scene must be active and existing GM/world authorization remains enforced.

Native `CONFIG.Token.documentClass.schema.fields.light` cleans and validates full current Token light merged with patch. Installed `App/common/documents/token.mjs:90` defines EmbeddedDataField(LightData). `App/common/data/fields.mjs:407` returns failure or undefined; any returned failure is rejected, including resolved/fallback failures. Exceptions fail; missing native API fails. No synthetic acceptance. Only `{light:fullMergedNativeLight}` is updated; sight/detection/hidden/link/position and actor prototype remain untouched.

Expected and verified state are `{light:fullAuthoritativeLight}`; deep canonical comparison detects auxiliary light drift and readback mismatches. Native normalization drives no-op detection. Existing serialized core lane, request deduplication and uncertainty fence remain in use; post-mutation world/GM checks remain enforced. Receipt contains only light state, not full token.

Focused regressions 5 passed: native normalization+unrelated token/light fields preserved; bounded strict/native rejection; animation drift; dedup+normalized no-op; readback/world drift uncertainty fencing. Full native suite 353 passed, log `prompt4-token-light-native-tests.txt`. Module typecheck awaits shared declaration refresh by root; worker did not build, reload, restart or execute live mutations.

Changed production files: local-api `shared/src/session-actions.ts`, `module/src/commands/session-actions.ts`; new test `module/src/commands/session-actions.light.test.ts`.
