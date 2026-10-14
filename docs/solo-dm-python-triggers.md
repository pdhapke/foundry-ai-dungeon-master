# Python automatic observation contract

Python accepts the same optional automatic hint carried by the typed application
request: kind (area/door/turn), worldId, sceneId, documentId, nonnegative safe
integer revision and bounded transition, with optional tokenId/regionId/key.
Identifiers are ASCII IDs of 1..128 characters; area requires all three optional
identifiers. Transition length follows JavaScript's 256 UTF-16-unit bound.
Unknown fields, malformed IDs, unsafe integers and mismatched active world fail
before the model runs. Python also recomputes the kind-prefixed SHA256 request
identifier using the Node contract's ordered compact JSON array.

The gateway principal supplies the expected world. Browser origin/correlation
claims are not accepted as hint fields. Stored hidden context preserves the hint
and request ID as untrusted automatic-observation data, classified as an
authenticated GM observation hint. It explicitly grants neither game execution
authority nor verified physical-event/bridge provenance. Actual bridge mutation
origin markers are a separate authenticated transport contract and cannot be
invented by Python from an observation prefix.

The action continues through the existing shared respond/context builder and
single model loop. Ordinary action fields and fixed tools retain their behavior.
Offline tests cover valid kinds, malformed/world-mismatched/oversized fields,
digest mismatch and data-only hidden context. They do not prove real hooks,
Regions, doors, remote combat or model behavior.
