# Prompt 4 live evidence independent gate

Independent source/evidence review only. This reviewer made no live calls, mutations, reloads or inference requests. Findings below audit root-captured JSON against its helper implementation; they do not independently attest a running browser or HTTP server.

## Source adapter traces reviewed

`prompt4-live-adapter-original-surroundings.json` captures current source `ChatKitReadTools` using production authenticated MCP transport. `scripts/prompt4-live-adapter.ts` constructs that source adapter directly; it does not call the loaded AI HTTP gateway, Python ChatKit process or embedded component. It initializes a fresh GM run after current world, GM user and active-user checks and requires the intended player client capability identity before/after native execution.

Connected case at 02:44:00 UTC October 3 (9:44 PM Central October 2): returned `ready`, exact world `izzy-campaign`, intended non-GM user/client, scene `Nbj38PEdvw1zX1J9`, token `5afpFlCHHnclifNw`, native observation UUID and state digest. Trace contains exactly one `foundry_get_token_visibility` call for that exact selection, `queryPoints:[]`, with capability checks before/after and GM authorization checks before/after. **Facts were empty**. This proves bounded connected source-adapter observation readiness, not a surroundings description, secret-door success, multiple-source success, or player rendering. Helper constructs no campaign context, so it cannot exercise authored campaign point descriptions in this run. Measured adapter span ~252.23 ms; it is not action/receipt/narration timing.

Attempted GM substitution in the same capture returned `NOT_CONNECTED`, null binding/source revision and empty facts. No second visibility call appears. This supports no GM fallback for that requested substitute.

`prompt4-live-adapter-disconnected.json` after root-reported targeted player reload: selected player and attempted GM substitution both returned `NOT_CONNECTED`, null binding and empty facts. There are **zero** `foundry_get_token_visibility` calls in that trace: only world/user/status authorization and capability reads. Exact-client refusal precedes native dispatch. Measured adapter spans ~106.39 ms and ~74.31 ms. JSON alone does not prove why the player connection became absent; supported reload/browser state must be established by separate root evidence.

Both traces and helper show only read tool names, `inferenceRequests:0`, `mutations:0`. The helper has no model client and performs no inference. No credentials appear in these evidence artifacts.

## Prevalidation capture / unchanged state

`prompt4-live-fixture-prevalidation-ledger.json` records `operations:[]` and `captureClosedWithoutMutation:true`. Actor validation reported valid but returned two `UNKNOWN_FIELD` warnings for dynamic ownership map keys. Helper requires valid plus zero warnings and throws **before** `foundry_create_actor`; no test scene, actor or fog fixture was created in this attempt. Root did not bypass the warning gate.

Recorded after-checks show original scene, three original actors, both original viewports, original scene fog for GM/player, consent, active scene, pause, combat and automatic-events state unchanged. This reviewer inspected those recorded comparisons, not the live state. `fixtureSceneDeleted:true` / `fixtureActorDeleted:true` mean planned fixture IDs were absent; they do not demonstrate deletion after a created fixture. `fixtureFogVerifiedBeforeDeletion:false` is expected because no fixture scene existed. Ledger `restored:false` must not be presented as completed created-fixture restoration; accurately describe this attempt as closed without mutation and originals recorded unchanged.

## Gate status and limits

Independently audited artifact claims: connected source-adapter exact-client readiness with empty facts; disconnected exact-client refusal; GM substitution refusal; no native execution for negative cases; model-free/read-only helper scope; native validation warning stop before writes; recorded original-state comparison.

Not passed by these artifacts: loaded AI HTTP route, Python safe-lane execution, actual ChatKit custom element rendering, intended-player browser observations, repaired secret door/multiple-source live cases, meaningful observable descriptions, consent/ownership changes during live execution, expiry under actual server, paid narration secrecy or manual player acceptance. Runtime startup hashes/current native client markers require separate identity evidence. Root will provide later browser/phase evidence for an additional review; no polling was performed.

## Completed bounded fixture phase (independent artifact review)

Reviewed `prompt4-native-observations-1790996159630.json`, `1790996183259`, `1790996185974`, `prompt4-live-adapter-fixture-closed.json`, completed `prompt4-live-fixture-ledger.json`, `prompt4-live-restoration-verification.json` and separate partial-scene-validation ledger. No additional live requests were made by this reviewer.

**Closed door / hidden filtering:** Native receipt at 02:55:59 UTC has `complete`, no issues, exact opted-in non-GM owned primary token/client, native revision unchanged, pending flags zero. Visible token set contains only primary: target beyond door and test-owned hidden token are absent. Near query is visible; beyond-door query is invisible with `visible-wall` attribution and opaque blocker key. One generic closed door is reported, with destination redacted. FOV polygon is wall-clipped rectangle and was not interpreted here as radial sight range.

**Actual source adapter observable result:** Fixture source-adapter trace at 02:56:19 UTC dispatches exactly one selected-player native visibility read, current authorization and client checks around execution. It returns one approved fact, `A closed door is visible.`, bound to that same native revision and exact intended client/token, with opaque hash provenance. Unknown threat/being-noticed/trap/unobserved-area remain unknown. GM substitution returns `NOT_CONNECTED` before any additional native visibility call. Selected source-adapter span ~160.02 ms. This is a concrete model-free adapter fact, **not loaded HTTP/Python/embedded browser proof**. No authored campaign point description was queried (`queryPoints:[]`).

**Secret door:** After confirmed native secret-door update (`door:2,ds:0`) the native receipt is **incomplete** with `QUERY_FAILED`. Beyond-door query is unseen, `environment-ambiguous`, no blocker keys and no visible barriers; hidden/occluded token IDs remain absent. This demonstrates secret barrier redaction and conservative uncertain-cause handling. It does not justify describing the obstruction as a secret door, identifying a precise hidden wall, or claiming complete usable secret-door narration. A strict adapter should withhold the entire incomplete receipt; a live secret-door adapter path was not captured here.

**Multiple source:** Primary receipt remains incomplete due the same uncertain secret obstruction. Second owned token receipt reports `TOKEN_VISION_INACTIVE`, effective vision=0, isolation incomplete, no coverage/visible entities, and one unrelated vision source ignored. Thus it refuses to borrow the primary token's active source. This is a bounded correct inactive-source refusal under actual player permission, **not a successful test of two simultaneously active vision sources**. No unrestricted GM source merge is demonstrated or required by these artifacts.

## Completed fixture restoration review

Full ledger has valid zero-warning native validations for actor, scene, wall and token setup/update, confirmed test-owned creations, secret update and second token creation. `restored:true`; independent root restoration JSON agrees with ledger verification.

Fixture fog checks are nonempty (two rows for GM/player) and each explicitly records the still-existing fixture scene, `sceneStillExists:true`, `absent:true`, at 03:01:19 UTC. The ledger then records confirmed deletion of exact test-owned scene and actor. This supports proper **pre-deletion fog verification**; no post-deletion getter was used to infer fog absence. Original scene fog is separately reported unchanged for both original users.

Original pre-reload target viewports in completed ledger exactly match the earlier prevalidation ledger's `targetViews`. Baseline text explicitly retains first capture and refuses replacing it with reload-default pan. Final comparisons record both original viewports matching, original scene and three original actors unchanged, original fog/consent unchanged and active-scene/pause/combat/automatic-events unchanged.

Two failed pan attempts are reconciled: `resolved_no_effect` for wrong current scene (native precondition precedes pan), and `resolved_not_dispatched` for exact-player lease expiry before routing. Recorded later acknowledgments and confirmed fresh restoration commands provide the final original viewport checks. No `uncertain` operation remains in completed ledger; these were not blindly replayed as successful receipts.

Separate partial-scene-validation ledger has a confirmed temporary actor creation, then scene warning gate stopped before scene creation. Confirmed actor deletion and original-state comparisons are recorded. Its planned scene never existed; its `fixtureFogVerifiedBeforeDeletion:true` must not be treated as evidence of a created scene's fog cleanup. Actual full-fixture evidence above has real nonempty checks and resolves that acceptance requirement.

Root reported revoked-ownership prevalidation failed without write. No completed live ownership change/revocation result appears in the reviewed fixture ledger; **no live ownership-revocation acceptance is claimed**.

## Updated bounded acceptance

Passed by reviewed evidence: live native closed-door visibility/attribution and hidden filtering; real source-adapter deterministic closed-door fact; secret metadata redaction with explicit incomplete uncertainty; inactive second-source refusal; disconnected/GM-substitute refusal; completed full-fixture pre-deletion fog cleanup and recorded restoration to earliest original views/state.

Still blocked/untested by this gate: two-active-source success, complete secret-door adapter narration, live revoked ownership, authored public point descriptions, loaded AI HTTP/Python/actual embedded SDK rendering and narration, manual player feedback, broad modes/elevation/path/automation combinations. No model inference was executed, and no live narration approval is implied by these artifact checks.

## Loaded embedded safe action and second live phase

Root observed the actual isolated GM “Player surroundings” embedded component render `A closed door is visible.` after its button action at approximately 03:19 UTC. This reviewer did not repeat browser interaction. Independent read-only inspection tied the exact Node/Python trace `fc16134f-b024-4745-96ea-b6845fdfd10d` to durable safe-store item hash `e03a2937a586e348fdc601ec`, created 03:19:57 UTC. The matched thread has exactly **one assistant message**, that exact fixed public text, no hidden context/private protocol pairs, and immutable intended Izzy world/scene/client/token binding. Separate safe record contains one `visible-door` fact with native-visible-barrier basis, active public decision, policy `player-surroundings-v1`, opaque dependency hash at the same state revision and all four unknowns. No GM history was copied into this safe thread.

Compact independent evidence: `prompt4-live-safe-trace-independent.json`. Node trace contains two actual adapter spans (~5493.90 ms and ~2292.01 ms), Python durable item commits, stream authorization and final response completion (~8723.21 ms from Node request arrival). Model-request/provider stages count **zero**. Source safe path disables model/GM reconstruction and performs only authenticated surroundings reads; no narrator pass was added. Trace first-visible-stream-chunk ~273.33 ms occurs before those reads and is transport startup, **not** receipt/narration browser paint. Python scope starts at commit in this path; its elapsed values are not total action timing. This evidence establishes loaded HTTP→Python→adapter execution and safe receipt durability; actual browser paint remains root's direct observation rather than this reviewer's observation.

Reconnect limit: persisted one safe message and binding support safe reconstruction structurally, but no fresh actual SDK reconnect/history reload was performed by this reviewer. No player-owned chat access is implied: the pane is GM-operated with intended-player perception authorization. Safe record did not infer threats, being noticed or traps.

Second native capture `prompt4-native-observations-1790997682837.json` now shows **both** owned tokens complete, each with selected vision=1 and unrelated active source ignored=1. Primary sees only its side/itself and not beyond door; secondary sees its side plus test target and not the primary side. Both have opposite correct bounded query results and opaque visible-door attribution. This supports two concurrently active intended-player source isolation, extending beyond the earlier inactive-source refusal. Separate source-adapter traces `prompt4-live-adapter-two-source-primary.json` and `-second.json` each return exact token binding and generic closed-door fact; GM substitutes remain NOT_CONNECTED. They remain separately constructed source adapters, not two additional embedded browser samples.

Second secret capture `prompt4-native-observations-1790997748221.json` remains incomplete for explicit cross-secret queries with uncertain environmental attribution. No visible barrier/key exposes the secret door. `prompt4-live-adapter-secret-second-run.json` requests **no** query points and returns ready with **zero facts**, retaining all unknowns. That is safe native-only empty observation, not a successful secret-door narrative or proof of complete queried secret perception. Python empty-fact safe projection is explicitly unsupported; it must not invent surrounding prose.

Latest fixture restoration remains pending at this document update; root will provide completed ledger for independent artifact comparison. No runtime or inference actions were issued by this reviewer.

## Second-run restoration and revoked ownership completion

Completed second ledger (`runId:ba55fff9-2a01-41fb-9240-9b7e45352c6a`, fixture scene `cbyniU1p5punoUkD`) now reports `restored:true`; every operation is confirmed and every restoration comparison row/boolean is true. `prompt4-second-restoration-inspection.json` deliberately preserves the **initial failed** check: original pause=true versus current=false, and player's scene-load-adjusted viewport different from captured coordinates/scale. These initial mismatches were not concealed as success.

`prompt4-restore-second-settled.mjs` guards world/no pending uncertainty and original player scene, then reapplies exact captured player viewport and original pause value. Ledger has confirmed receipts for both corrective operations at 03:27:29 UTC, followed by final independent root verification matching both viewports, original scene/actors/fog/consent/active scene/pause/combat/automatic events. This reviewer audited completed artifact claims and helper sequencing; did not issue a redundant native request.

Two actual fixture fog checks at 03:26:32 UTC explicitly have `sceneStillExists:true`, `absent:true` for GM/player. Confirmed fixture scene deletion follows those checks; actor deletion is confirmed. No post-deletion getter is interpreted as fog absence. Separate original scene fog comparisons remain true. Second-run restoration evidence must be archived before third-run helper overwrites generic current-ledger filenames.

**Live changed ownership:** Second ledger's `revoke fixture ownership` operation is confirmed with authoritative actor readback assigning intended player ownership=0 (GM ownership=3 retained). `prompt4-live-adapter-revoked-ownership.json` then returns unavailable/`INVALID_EVIDENCE`, null binding and empty facts for exact selected player; attempted GM substitute remains NOT_CONNECTED. This supports fail-closed live changed-ownership refusal. Error code is generic invalid evidence, not a typed ownership reason; do not call it connected success or specific revoked-consent evidence.

Root additionally observed a fresh actual embedded secret-state request render exactly `Player observations are unavailable; no description is confirmed.` at approximately 03:26 UTC, with no secret identifiers in the public message. This is root browser observation plus existing safe projection behavior; reviewer did not personally capture AX state. It strengthens actual embedded fail-closed behavior, not successful secret-door narration.

Second-run gate complete: bounded real closed-door safe receipt (loaded HTTP/Python durable), two concurrently active selected-player source isolation, changed-ownership safe refusal, conservative secret-state refusal and complete recorded restoration. Secret-door semantic completeness remains a blocker pending repaired third-run validation; ordinary unrestricted GM prose secrecy and manual player acceptance remain outside these receipts. No model calls were authorized/executed by this reviewer. Third-run evidence, if produced, requires a separate gate and cannot inherit this restoration claim.

## Final third-run independent gate (completed)

Third run `7e45ca39-e7bf-40dc-b4c1-aac30158e698` is archived as `prompt4-live-fixture-third-completed-ledger.json`. Independently reviewed repaired native report `prompt4-native-observations-1790998246086.json`, `prompt4-live-adapter-secret-repaired.json`, current receiver marker evidence, runtime identity and final restoration ledger. No runtime/model/mutation calls by reviewer.

**Repaired native secret perception:** Now `complete` with no issues, exact opted-in owned intended player/client, zero pending flags and unchanged revision. Near point visible; far point invisible. Unknown environmental cause remains `environment-ambiguous` with empty blocker keys, and `visibleBarriers:[]`; secret door ID/coordinates/label are not emitted as a visible entity. Visible tokens contain primary only, excluding concealed and occluded targets. This fixes treating a valid unseen point with an undisclosed cause as whole-report validation failure. It does **not** authorize a precise explanation, secret-door discovery, seeing the hidden target, or radial-range inference from the clipped polygon.

**Real source adapter:** Repaired trace is `operation:token_perception`, not surroundings narration. It accepts the native complete exact-client receipt and returns only approved projection; GM substitute returns unavailable `PLAYER_CLIENT_UNAVAILABLE` and empty visible sets. Selected adapter span ~733.23 ms. No GM fallback, model request or mutation. Earlier loaded embedded success is separately proven by safe closed-door text/trace; this token-perception source harness itself is not loaded HTTP or SDK evidence.

**Actual safe embedded third scene:** Root observed the isolated GM pane render fixed `Player observations are unavailable; no description is confirmed.` for this secret-only scene. Independent read-only SQLite inspection finds one exact-intended-client safe thread, hash `d81c3589ec246de82fe65ac4`, with one assistant message created 03:31:39 UTC, hash `17a3beb35143ffe0dcc2edf3`, containing exactly that text and no hidden/private protocol items. Separate safe record status is `unsupported`, facts empty. This is intentional: secret-only native visibility supplies no approved descriptions or visible-door fact. It confirms strict output does not invent prose or expose secrets; it is **not** successful natural narration or secret discovery. Ordinary GM component/history remains separate by source/store contract; no raw private transcript is inspected/published here.

**Current identities:** `prompt4-native-readiness-verified.json` at 03:29:07 UTC has exact receiver acknowledgments and current instrumentation marker `b810440a5c12f4aceea6e5347b4e5312360ef8ce8735e47bceebce7065ccd2f2`, matching both intended player and GM receivers, gate PASS. `sceneReady:false` is preload bookkeeping, not paint failure/proof. `prompt4-runtime-after-build.json` at 03:32:09 UTC records AI Node startup03:12:19.926Z manifest `667f8f02e40ed0943fce1385af26aa9ee441bd040928372297606b7e5f31d18a`, all reported AI startup/disk artifacts equal; MCP Node startup03:12:12.983Z manifest `a38d56ec356a7dd87b62421e9eee6b9de61236626ff5f`. Its native module startup hash differs from current disk after client-only repair/reload; that is historical startup metadata and does not invalidate current receiver marker evidence. Python app digest `a2296acb034408e5374a52f5b6d904bdbd64abaf5337a02d4d052a9c8aedad33` and player contract digest `ac1ab034a61a351112ea65d6665af05ec040f00c88885f258061f6484cafaa73` each match disk in the captured health response. Reviewer audited saved identity response; did not create a fresh service-health claim.

**Restoration:** Third ledger `restored:true`, no pending/uncertain/nonconfirmed operation. Two actual GM/player fixture fog checks at 03:33:14 UTC explicitly say scene still exists and fog absent. Confirmed scene deletion follows at03:33:14.722Z and actor deletion at03:33:15.119Z. Final comparisons all true for fixture absence, both original viewports, original scene/three actors/fog/consent, active scene, pause, combat and automatic events. No post-deletion fog getter inferred absence. Earlier second-run archival and its pan/pause correction remain separate historical evidence.

### Final bounded matrix

| Independently audited outcome | Status / limit |
|---|---|
| Offline player-safe contracts, source mapping, cache/identity/reconnect guards | Passed bounded tests; actual fresh SDK reconnect remains untested |
| Actual loaded embedded regular-door receipt / durable safe-store separation | Passed via root browser observation plus independent trace/store correlation; deterministic, zero model calls |
| Two simultaneously active intended-player source isolation | Passed bounded native + source adapter both owned tokens; no unrestricted GM union |
| Repaired secret-door point visibility / redaction | Passed bounded native complete + source adapter; precise unseen cause remains unknown |
| Secret-only player prose | Explicit unsupported fixed receipt; no approved semantic description, no synthetic success |
| Disconnect/GM substitution/changed ownership | Passed bounded source-adapter refusals; broad consent expiry race matrix not generalized |
| Full fixture restoration | Passed recorded third and second completed ledgers; actual nonempty pre-deletion fog checks |
| Freeform model narration secrecy / playtest acceptance | Not run, no paid inference approval; manual player feedback required |
| Broader modes, actual elevation moves, complex paths/traps/automation | Deferred/untested |

This final gate supersedes earlier secret validation blockage only for the repaired bounded visibility/redaction case. It does not upgrade unrestricted GM model prose to a strict secrecy guarantee. Stop for manual acceptance; later saved prompts remain unlaunched.
