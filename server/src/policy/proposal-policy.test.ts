import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";

import { authorizeCommit, evaluateProposal } from "./proposal-policy.js";
import type { AiDmPolicyCatalog, AiDmPolicyToolRecord } from "./types.js";

const principal: AiDmRunPrincipal = {
  clientId: "client-1",
  connectionId: "connection-1",
  userId: "player-1",
  lane: "player",
  worldId: "world-1",
  isGm: false,
  role: 1,
  authorizedAudienceKinds: ["private"],
  permissionSnapshotRevision: "permissions-1",
};

function catalog(record: Partial<AiDmPolicyToolRecord> = {}): AiDmPolicyCatalog {
  const tool: AiDmPolicyToolRecord = {
    toolId: "foundry_create_token_guarded",
    revision: "tool-1",
    schemaDigest: "schema-1",
    effects: ["propose", "commit"],
    risk: "consequential",
    approvalPolicy: "gm-approval",
    available: true,
    requiredPermissions: ["gm"],
    supportsExpectedRevision: true,
    supportsIdempotency: true,
    ...record,
  };
  return {
    catalogRevision: "catalog-1",
    policyRevision: "policy-1",
    get: (toolId) => (toolId === tool.toolId ? tool : undefined),
  };
}

function proposalInput() {
  return {
    proposalId: "proposal-1",
    runId: "run-1",
    causeEventId: "event-1",
    summary: "Create the triggered creature.",
    expiresAt: "2026-09-29T01:00:00.000Z",
    operations: [
      {
        operationId: "operation-1",
        toolId: "foundry_create_token_guarded",
        arguments: { sceneId: "scene-1" },
        expectedRevisions: [
          {
            provider: "foundry",
            resourceKind: "Scene",
            resourceId: "scene-1",
            revision: "scene-r1",
          },
        ],
      },
    ],
  };
}

void describe("AI Dungeon Master proposal policy", () => {
  void it("requires GM approval and derives trusted metadata server-side", () => {
    const result = evaluateProposal(
      proposalInput(),
      principal,
      catalog(),
      "2026-09-29T00:00:00.000Z",
    );
    assert.equal(result.decision, "require-gm");
    if (!("proposal" in result)) assert.fail("Expected a proposal.");
    assert.equal(result.proposal.approvalAuthority.kind, "gm");
    assert.equal("idempotencyKey" in result.proposal.operations[0]!, false);
  });

  void it("refuses consequential legacy tools without CAS and idempotency", () => {
    const result = evaluateProposal(
      proposalInput(),
      principal,
      catalog({ supportsExpectedRevision: false }),
      "2026-09-29T00:00:00.000Z",
    );
    assert.deepEqual(result, {
      decision: "refuse",
      code: "UNSAFE_COMMIT_CONTRACT",
      message: "A proposed capability lacks revision or idempotency guarantees.",
    });
  });

  void it("rejects stale revision and otherwise issues one-call idempotent grants", () => {
    const policy = catalog();
    const evaluated = evaluateProposal(
      proposalInput(),
      principal,
      policy,
      "2026-09-29T00:00:00.000Z",
    );
    if (evaluated.decision === "refuse") assert.fail(evaluated.message);
    evaluated.proposal.status = "approved";

    const conflict = authorizeCommit(
      {
        proposal: evaluated.proposal,
        principal,
        approval: null,
        currentRevisions: [
          {
            provider: "foundry",
            resourceKind: "Scene",
            resourceId: "scene-1",
            revision: "scene-r2",
          },
        ],
        now: "2026-09-29T00:10:00.000Z",
      },
      policy,
    );
    assert.equal(conflict.allowed, false);

    const allowed = authorizeCommit(
      {
        proposal: evaluated.proposal,
        principal,
        approval: null,
        currentRevisions: proposalInput().operations[0]!.expectedRevisions,
        now: "2026-09-29T00:10:00.000Z",
      },
      policy,
    );
    assert.equal(allowed.allowed, true);
    if (!allowed.allowed) assert.fail("Expected a commit grant.");
    assert.equal(allowed.grant.operations[0]?.maximumCalls, 1);
    assert.equal(allowed.grant.operations[0]?.idempotencyKey, "ai-dm:proposal-1:operation-1");
  });
});
