# Prompt 4 integration contracts and weekend limits

Run order is Prompt4 first, then user-directed Prompt1 speed/memory/recipes, Prompt2 campaign preparation, Prompt3 UI. No later effort was launched and no runtime model/event settings changed.

## Preparation and UI

`shared/src/player-observation.ts` exposes `PlayerPerceptionReadiness` and exact internal provenance binding. `server/src/chatkit/player-readiness.ts` maps validated adapter observations; only complete non-GM opted-in request-local observation with pending flags zero can be ready. NOT_CONNECTED stays actionable. Server/GM health never suffices. The mapper is an internal seam for upcoming preparation/UI work; the separate GM-side Player surroundings panel now has actual embedded receipt evidence. Callers must use `ChatKitReadTools` results, never raw GM snapshots or saved stale reports.

## Campaign records and reveals

The localized terrain rehearsal uses an approved public record under the existing `campaign/observations` directory. The loaded reserved observation source domain validates its own bounded complete set without unrelated private campaign parse errors disabling all descriptions. Legacy whole-campaign point planning remains compatible when that directory is absent; invalid observation-domain data must never fall back to broader private sources. This is the existing campaign schema/parser/store, not another campaign system. Live positive acceptance passed through the loaded HTTP/Python panel with two authenticated observations and zero model calls; the user accepted the exact public sentence.

`PlayerRevealDecision` reuses existing `AiDmVisibility`, `AiDmAccessScope`, `AiDmContextActivation`, and `AiDmContextDependency`; use the existing presenter/resolver policy and campaign store. An approved public description still needs scene/audience/revision binding; conditional facts require active reveal conditions and dependency checks. Private resolver evidence remains in GM adjudication. The bounded surroundings producer accepts only canon public point-scoped records with exact scene/query elevation binding. Conditional and DISCOVERABLE reveals remain unsupported.

`PlayerObservableFact.kind` deliberately distinguishes area-visible, threat-noticed, observer-noticed-player, and trap-triggered. One never entails another. Private IDs, coordinates, notes, rationale, source URI/labels and raw error text have no public narration slot. Description strings require trusted approved provenance; these types alone do not validate or declassify arbitrary model text.

## Surroundings

Explicit `foundry.player-observation` custom action takes exact {requestId,worldId,sceneId,userId,clientId,tokenId}. It skips model credential resolution, uses two live adapter observations and rejects revision/audience changes before publication. It enrolls an empty separate safe thread; existing GM history cannot be repurposed. Reconnect loads only safe items. Ordinary GM narration retains the weaker policy-only guarantee.

The bounded player_surroundings adapter projects validated visible barriers and doors into fixed descriptions. It admits approved PLAYER-VISIBLE or OBSERVABLE plain text only from canon public campaign records scoped to an exact native-visible query point and elevation. It strips source labels/links/coordinates and retains opaque provenance in safe records. Source revision changes during observation return stale; missing safe facts return unsupported. Threat, being noticed, traps and unobserved areas remain unknown. Independent adversarial gates cover private sections, retrieval injection, cache visibility changes, secret barriers and identity mismatches. Actual embedded HTTP/Python/authenticated-adapter flow rendered a fixed closed-door description and secret-state refusal, independently correlated to the safe store. One approved public campaign point description passed the final live gate; conditional reveals and general terrain descriptions remain outside its scope. No extra model pass is used.

## Deferred encounter coverage

Basic/darkvision and bounded straight movement are the supplied tested scope. Other modes, actual elevation movement, complex paths, trap automation and broad automation combinations remain untested/unsupported until a specific selected encounter demands them. Query-point public Region Z containment is separate from token top-exclusive membership. Wall-clipped FOV is not radial range, visible obstruction is not proof of a darkness/environmental cause. Bounded native secret-door validation/redaction/complete unknown-cause visibility and two-active-source isolation now passed under intended player permissions. Successful invisible observations with unknown public cause are distinct from actual failed queries; neither declassifies secrets or proves a noticed threat.

## Next manual gates

1. Completed offline/live/independent gates and restoration are in prompt4-acceptance-gate.md. Exact current client marker is separately proven from historical Node startup native hashes. No service lifecycle operations performed.
2. Manual player feedback on the original calibrated scene passed through the strict deterministic panel. Reverify exact consent/ownership/readiness; the deferred automatic renewal defect means a healthy server does not imply an unexpired player lease.
3. Optional ordinary GM-model rehearsal proposal is in prompt4-weekend-rehearsal-proposal.md and requires fresh explicit approval. It has a weaker prose boundary and does not accept an unimplemented strict natural LLM narrator. Current inference allowance remains zero.
4. Threat/trap reveals, other modes/elevation/complex paths remain unsupported or deferred. No later effort launches automatically.


