# Terrain attempt restoration independent gate

PASS for saved Foundry state restoration; positive terrain narration remains blocked separately. Read-only recursive artifact comparison only; no runtime calls, build, mutation or inference.

Compared full `prompt4-terrain-state-before.json` (21:13:22.806Z) and `prompt4-terrain-state-after.json` (21:20:16.686Z). Every actual captured state field equals: worldId, full scene (including all embedded token/wall/light data), full selected token, full actor, both exact client views/generations, pause, full combat list, automatic event setting and both original-user fog records/revisions/content. InferenceRequests and mutations each remain0.

The literal JSON documents are not byte-identical. Differences are only capture timestamp, mode before/after and an after-only movement annotation. That annotation records400/650/elevation0 before and after, matching unchanged token coordinates; it is not a movement mutation. Existing scope text describes the reused snapshot capture helper, not proof a movement check occurred during this terrain attempt.

Both view rows match exactly including clientId/userId/connectedAt/sceneId/viewport. Izzy generation1791062002217 and GM generation1791058677401 are unchanged. GM viewport restored to3625/4875/scale1; player viewport464.7014493560503/521.1369640509241/scale1.446261688240654 unchanged. `prompt4-terrain-gm-view-restore.json` contains an actual acknowledged exact-GM viewport application at21:19:34.357Z, correlationc53ff7af-4fbf-4c05-b7f1-07c9f6809f87, expected/active original scene equal, viewporttrue, warnings[], incompletefalse.

Root reports the initial temporary focus acknowledgment timed out even though viewport applied. This review does not invent a successful initial focus receipt. Subsequent supported restore acknowledgment plus equal final read-only snapshot resolves the view state; no gameplay effect is inferred from that focus timeout. Panel close/deselect and Journal Notes restoration are root browser observations, not fields independently represented in these snapshots.

The separately approved public campaign observation record is intentionally retained; it is outside these Foundry snapshots and is not a restoration defect. No Foundry fixture scene/actor was created, no token movement occurred, and no fog clear/restore operation is claimed. Therefore no new fixture deletion/fog-before-delete requirement arises for this attempt. Original fog equality is supported by full captured state comparison, not proof of generalized exploration behavior.

This gate supports ending the attempt with captured Foundry state restored. It does not upgrade the fail-closed terrain reply to success or establish fresh future enrollment readiness. Positive narration/source planning repair and manual feedback remain governed by `prompt4-terrain-live-independent-gate.md`.
