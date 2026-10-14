# Independent native negative-observation semantics gate

Independent read-only code/test review and offline rerun. Requested `scene-perception.ts` does not exist; actual implementation is local-api `module/src/commands/scene-render.ts`, with `scene-render.test.ts` and `phase5-independent-perception.test.ts`. No production edits, browser operations, inference, mutations, service operations or client reload by this validator.

**PASS: 37 focused native tests**, including 8 independent baseline fixtures. Command from local-api module root: `node --import tsx --test --test-concurrency=1 module/src/commands/scene-render.test.ts module/src/commands/phase5-independent-perception.test.ts`.

The reviewed semantic change removes the synthetic QUERY_FAILED issue for a native successful negative visibility result without a player-visible blocker. Its cause remains `environment-ambiguous`; no false claim of darkness, fog, range, secret door or hidden threat is made. The former status difference between observable negatives and secret-caused negatives was a potential diagnostic oracle. Fixtures now assert identical complete negative query shape for secret barrier, lighting and distance-like exclusions, with no secret identity or barrier key.

This removal does not suppress actual native failures: selected detection exceptions still produce SELECTED_VISION_EVALUATION_FAILED and incomplete vision/status; malformed publicly visible barrier geometry still produces QUERY_FAILED; unsupported isolation/API/Region support remains unsupported; pending/missing native render state and perspective/state drift remain stale/unavailable and clear visible claims. Adapter consumers must continue rejecting incomplete/unsupported evidence; native incomplete reports may retain otherwise observed IDs, so they are not player narration contracts themselves.

Reviewed preservation and passing focused regressions:

- Secret doors and hidden barriers are filtered before geometry, attribution or response-local keys; hidden token/note/tile/Region/Journal identities remain filtered.
- Query nonvisibility never becomes radial out-of-range from wall-clipped field of view. Public wall evidence remains distinct `visible-wall`; absent native range evidence stays uncertain.
- Only selected owned-token detection modes/sources run; unrelated player/GM vision and vision-providing light cannot widen observations. Unsupported source identity remains explicit.
- Direct non-GM identity/consent, exact loaded scene, ownership and post-await perspective checks remain enforced. Pending or replaced sources clear claims.
- Explicit query elevation reaches detection and public Region containment; default query elevation uses selected token elevation. Prepared token membership remains separate from query-point containment.

Disk marker at review: `b810440a5c12f4aceea6e5347b4e5312360ef8ce8735e47bceebce7065ccd2f2`. This is a disk native bundle marker only; historical Node startup native hashes and a targeted client's currently loaded marker must be reported separately. Root must verify receiver marker after supported client reload before live third-run claims.

Gate: **independently passed offline negative/exception semantics and preserved boundaries**. Actual browser secret-door result, exact live adapter rendering, current loaded marker, fixture restoration and player manual acceptance remain outside this validator's gate. No broad all-mode acceptance claim.
