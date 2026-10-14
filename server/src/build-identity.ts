import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const artifacts = [
  "server/dist/latency-trace.js",
  "server/dist/context/world-campaign.js",
  "server/dist/context/protected-campaign.js",
  "server/dist/context/campaign-migration.js",
  "server/dist/campaign-privacy.js",
  "server/dist/context/campaign-storage.js",
  "server/dist/index.js",
  "server/dist/app.js",
  "server/dist/config.js",
  "server/dist/auth/chatgpt-plan-auth.js",
  "server/dist/chatkit/prepared-context.js",
  "server/dist/chatkit/gateway.js",
  "server/dist/chatkit/read-tools.js",
  "server/dist/chatkit/player-perception.js",
  "server/dist/chatkit/player-readiness.js",
  "server/dist/integrations/foundry-local-api-mcp.js",
  "server/dist/tool-catalog/metadata.js",
  "server/dist/chatkit/catalog-tools.js",
  "server/dist/chatkit/pause-actions.js",
  "server/dist/chatkit/core-actions.js",
  "server/dist/chatkit/attack-actions.js",
  "server/dist/chatkit/attack-sequences.js",
  "server/dist/chatkit/session-actions.js",
  "server/dist/chatkit/pause-request.js",
  "server/dist/chatkit/routine-completion.js",
  "server/dist/chatkit/narration-request.js",
  "server/dist/chatkit/tool-audit.js",
  "server/dist/chatkit/world-request.js",
  "server/dist/chatkit/world-document-actions.js",
  "server/dist/chatkit/world-tool-policy.js",
  "server/dist/chatkit/world-file-actions.js",
  "server/dist/chatkit/world-files.js",
  "server/dist/chatkit/native-actions.js",
  "server/dist/chatkit/campaign-actions.js",
  "server/dist/chatkit/turns.js",
  "server/dist/chatkit/preparation-contract.js",
  "server/dist/preparation-service.js",
  "server/dist/preparation/records.js",
  "server/dist/preparation/retrieval.js",
  "server/dist/preparation/source-drafts.js",
  "server/dist/preparation/source-inventory.js",
  "server/dist/preparation/record-composition.js",
  "server/dist/preparation/publication-review.js",
  "server/dist/preparation/outcome.js",
  "server/dist/preparation/trusted-review.js",
  "server/dist/preparation/interview-source.js",
  "server/dist/preparation-jobs/index.js",
  "server/dist/preparation-jobs/grid-audit.js",
  "server/dist/preparation-jobs/native-adapter.js",
  "server/dist/preparation-jobs/durable-native.js",
  "server/dist/preparation-jobs/world-native-transport.js",
  "server/dist/preparation-jobs/local-asset-import.js",
  "server/dist/chatkit/bounded-call.js",
  "server/dist/tool-catalog/runtime.js",
  "server/dist/tool-catalog/catalog.js",
  "server/dist/tool-catalog/canonical.js",
  "server/dist/tool-catalog/foundry-local-api-adapter.js",
  "shared/dist/ai-dungeon-master.js",
  "shared/dist/chatkit.js",
  "shared/dist/player-observation.js",
  "shared/dist/preparation/types.js",
  "chatkit-server/app.py",
  "chatkit-server/player_observation.py",
  "chatkit-server/dm_prompt.py",
  "chatkit-server/working_context.py",
  "chatkit-server/preparation/__init__.py",
  "chatkit-server/preparation/workflow.py",
  "chatkit-server/preparation/router.py",
  "chatkit-server/preparation/pipeline.py",
  "chatkit-server/recipes/index.json",
  "chatkit-server/recipes/start-combat.json",
  "chatkit-server/recipes/combat-round.json",
  "chatkit-server/recipes/surroundings.json",
  "chatkit-server/recipes/battlemap.json",
  "module/dist/index.js",
];

/** Capture once at startup, never present later on-disk edits as the running build. */
export function captureBuildIdentity(moduleRoot: string) {
  const hashes: Record<string, string | null> = {};
  for (const name of artifacts) {
    try {
      hashes[name] = createHash("sha256")
        .update(readFileSync(join(moduleRoot, name)))
        .digest("hex");
    } catch {
      hashes[name] = null;
    }
  }
  return {
    policy: "core-actions-v1",
    startedAt: new Date().toISOString(),
    manifestDigest: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
    artifactHashes: hashes,
    scope: "startup artifacts; verify Python health and browser module separately",
  };
}

