import assert from "node:assert/strict";
import { it } from "node:test";

import type { AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";

import type { ContextNodeRecord } from "./types.js";
import { contextAccessDecision } from "./visibility-policy.js";

const gm: AiDmRunPrincipal = {
  clientId: "client-1",
  connectionId: "connection-1",
  userId: "gm-1",
  lane: "gm",
  worldId: "world-1",
  isGm: true,
  role: 4,
  authorizedAudienceKinds: ["private", "gm", "selected-users", "table"],
  permissionSnapshotRevision: "permissions-1",
};

function record(disclosure: ContextNodeRecord["node"]["disclosureScope"]): ContextNodeRecord {
  return {
    visibility: disclosure.kind === "public" ? "public" : "gm",
    sectionKind: "gm-only",
    edges: [],
    node: {
      nodeId: "node-1",
      kind: "campaign-source",
      revision: "revision-1",
      authoritative: true,
      authority: "narrative-filesystem",
      readScope: { kind: "gm" },
      disclosureScope: disclosure,
      activation: { status: "active", conditionRef: null },
      title: "Secret",
      contentType: "text/plain",
      body: "secret",
      sourceUri: null,
      sourceHash: null,
      sourceSpan: null,
      edges: [],
      dependencies: [],
      stale: false,
    },
  };
}

void it("requires every presenter node to be disclosable to the complete public audience", () => {
  const request = {
    view: "presenter" as const,
    principal: {
      runPrincipal: gm,
      resolverCanReadSecrets: false,
      presenterAudienceScope: { kind: "public" as const },
    },
    activeConditionRefs: new Set<string>(),
  };

  assert.equal(contextAccessDecision(record({ kind: "gm" }), request).allowed, false);
  assert.equal(contextAccessDecision(record({ kind: "public" }), request).allowed, true);
});
