# Independent stored native evidence and secret attribution diagnosis

Scope: read-only inspection of current native source and root-captured reports. No live request, browser action, mutation, reload, inference or production edit was performed by this worker. Backend reports are not independent browser rendering or authenticated AI adapter traces.

## Bounded two-active-source evidence

Inspected `prompt4-native-observations-1790997682837.json`: exact world izzy-campaign, opted-in non-GM user edtBL96Yu3058QAT, client80f7f865-6ebf-4a83-ad44-33ab0c0747f2, scene cbyniU1p5punoUkD. Primary yG5NYzuzG5YgBslE and second294DANfBmpTBeRHG each report complete, no issues, readiness ready, pendingRenderFlags0, native detection-mode isolation complete, effective vision1, unrelatedVisionSourcesIgnored1. Both share same unchanged persistence revision within their captures.

Primary sees near-primary and not beyond-door; second sees beyond-door and not near-primary. Each negative regular-door point has only a redacted public blocker key, no document coordinates/identity. Primary visible list contains only itself; second additionally contains ordinary visible target PR3cfHYQ9msHXmBX. Exact hidden fixture token RuMNbvtZAmHZF6mY (recorded in ledger) is absent from both visible lists. Redaction flags are all true. This independently passes the stored bounded native source isolation/attribution and hidden-token checks. Actual player browser observations and authenticated AI adapter acceptance remain separately owned by root. No generalized mode/elevation/path acceptance follows.

## Secret-door negative attribution

Inspected `prompt4-native-observations-1790997748221.json`: same exact player/client/scene/tokens. Both have native readiness ready, pendingRenderFlags0, complete isolation/vision/environment evidence, vision1/unrelatedignored1 and unchanged persistence. Primary's beyond-door and second's near-primary remain visible:false; each near-own-source point remains true. Hidden target remains absent. Visible barriers empty, blocker keys empty, secretDoor redaction true. Exactly one QUERY_FAILED issue per report names the corresponding negative query and says no player-visible wall attribution is available.

Current root cause in `local-api/module/src/commands/scene-render.ts`:

- `visibleBarriers`409-414 explicitly excludes secret door2, hidden wall, or non-player-rendered wall before attribution. This is intentional secrecy protection.
- `evaluatedQueries`939-958 successfully runs native selected-source `isolation.test`. Its actual exception path has a different QUERY_FAILED message: query could not be evaluated.
- Lines973-981 then append QUERY_FAILED **even after successful evaluation** when result false and no public blocker key exists. `inRange` here merely denotes selected source present; it is explicitly not radial range evidence.
- Lines984-995 return environment-ambiguous for that negative result with empty keys. Overall status derives from issues, so the valid negative visibility observation becomes incomplete solely because its cause remains uncertain.

Thus this captured secret result is not a demonstrated native visibility API/validation failure. The implementation intentionally refuses private causal attribution and currently escalates that ordinary uncertainty into an incomplete overall result. The public contract must not state secret door, its ID, coordinates, a trap, environmental cause, or unrestricted GM rationale merely to make attribution succeed. FOV clipping must never be reused as radial range.

## Concrete repair or bounded defer

Supported semantic repair proposal (not implemented): distinguish a successfully evaluated invisible point with unknown cause from an unevaluated/unsupported query. Retain visible:false, current environment-ambiguous/empty blocker keys, uncertainty and public-only provenance, but do not add QUERY_FAILED solely because a known negative visibility outcome lacks public causal attribution. Apply this uniformly to all unattributed negative observations, independent of whether any secret exists. Keep true evaluation exceptions, stale/unavailable readiness, native unsupported modes, missing sources, truncation and malformed geometry failing explicitly. No synthetic successful visibility, secret-specific status suppression, GM source fallback or new paid model pass is needed.

Required regression/live gates before claiming repair: secret/hidden wall plus range/darkness/ordinary unknown negatives remain causally unknown; exceptions still fail; unsupported/stale still clear claims; exact intended player identity and one-source isolation stay unchanged; private causes/IDs/labels/geometry absent from adapter/public receipt. Re-run exact scene's model-free native and authenticated adapter probes plus actual player rendering. Do not silently loosen adapter's existing complete-result gate against current incomplete reports.

If weekend scope defers this contract change, mark **secret-door filtering and tested native visibility booleans passed**, **causal attribution unknown**, and **complete adapter/narration readiness for query sets containing an unattributed negative blocked**. A safe visible-only observation plan may provide local observable descriptions without claiming the concealed side, but does not prove complete secret-door end-to-end acceptance. Root's manual player acceptance and any inference approval remain required separately.

## Implemented uniform native semantics repair

At root request, the native `scene-render.ts` post-evaluation loop that generated QUERY_FAILED solely because no public blocker key existed was removed. Visibility evaluation, public barrier projection, environment-ambiguous/empty blocker keys and secret redaction remain unchanged. The decision has no secret-specific condition. Successful invisible observations are now complete when all other native readiness/evaluation/permission/source/environment gates are complete. Actual caught detection exceptions still emit SELECTED_VISION_EVALUATION_FAILED and yield incomplete environment. Actual query exception catch, malformed geometry, unsupported sources/modes, stale/unavailable readiness and other errors are untouched.

Updated native regression checks public wall attribution and ambiguous negative queries together; added matrix checking secret wall versus no-public-wall lighting/range-style native negatives have the same complete/false/unknown public contract; added query-specific native exception fixture retaining incomplete, sanitized typed error. Existing independent consent/identity/readiness/source/elevation/FOV fixtures remain passing. Focused perception suites37/37, module typecheck pass, native module build pass. Full suite log is `prompt4-native-secret-semantics-tests.txt`. No runtime reload, service change, inference or fixture mutation by this worker. Root must independently validate and targeted-reload the exact clients before a bounded live secret repeat; prior incomplete reports above remain historical evidence, not retroactively repaired.

Final full native suite348/348. Prepared marker `b810440a5c12f4aceea6e5347b4e5312360ef8ce8735e47bceebce7065ccd2f2`; prepared module/dist/index.js SHA256 `ac4e57acc53addfaef4984400c39f122d3d4a5102ab71354f85f5850abb0e0fa`. Production source/artifact unchanged after this build; these are disk identities, not current loaded client or historical Node startup identity.
