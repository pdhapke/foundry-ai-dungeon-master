import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AiDmContextBudget,
  AiDmContextRequest,
  AiDmNormalizedEvent,
  AiDmResolutionFact,
  AiDmRunPrincipal,
  AiDmRuntimeProjection,
} from "@foundry-ai-dungeon-master/shared";

import { CampaignSourceRepository } from "./campaign-source.js";
import { RevisionedContextGraph } from "./context-graph.js";
import { ContextService } from "./context-service.js";
import { ContinuationCapsuleSigner } from "./continuation-capsules.js";
import { CampaignMarkdownParser } from "./markdown-context-parser.js";
import type { ContextRunSeed, ScopeExpectation } from "./types.js";
import { ContextError } from "./types.js";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai-dm-context-"));
}

function writeFixture(root: string, path: string, content: string): void {
  const segments = path.split("/");
  const file = segments.pop();
  const directory = join(root, ...segments);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, file ?? "fixture.md"), content, "utf8");
}

function event(): AiDmNormalizedEvent {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    sequence: 1,
    eventType: "player.prompt.submitted",
    source: "direct-prompt",
    occurredAt: "2026-09-29T18:00:00.000Z",
    receivedAt: "2026-09-29T18:00:00.100Z",
    authenticatedIdentity: {
      clientId: "client-1",
      userId: "player-1",
      lane: "player",
      worldId: "world-1",
      isGm: false,
    },
    presentation: "normal",
    requestedAudience: { kind: "private" },
    contextHints: {},
    payload: { text: "What do I see?" },
    payloadHash: "payload-revision",
    sourceCorrelationId: "request-1",
    deduplicationKey: "dedupe-1",
    sourceStateRevision: null,
  };
}

function principal(): AiDmRunPrincipal {
  return {
    ...event().authenticatedIdentity,
    connectionId: "connection-1",
    role: 1,
    authorizedAudienceKinds: ["private", "table"],
    permissionSnapshotRevision: "permissions-1",
  };
}

function projection(): AiDmRuntimeProjection {
  return {
    projectionId: "projection-1",
    eventId: "event-1",
    revision: "projection-revision",
    capturedAt: "2026-09-29T18:00:00.200Z",
    worldId: "world-1",
    authoritativeUserId: "player-1",
    permissionRole: 1,
    activeSceneId: "scene-1",
    controlledTokenIds: ["token-1"],
    controlledActorIds: ["actor-1"],
    targetTokenIds: [],
    activeCombatId: null,
    activeCombatantId: null,
    activeCombatantTokenId: null,
    activeCombatantActorId: null,
    combatRound: null,
    combatTurn: null,
    campaignStateRevision: "7",
    sourceRevisions: { campaign: "7" },
    selectedDocumentUuids: [],
  };
}

const normalBudget: AiDmContextBudget = {
  maxReads: 12,
  maxDepth: 3,
  maxNodes: 32,
  maxCharacters: 64_000,
  maxEstimatedTokens: 16_000,
};

function seed(overrides: Partial<ContextRunSeed> = {}): ContextRunSeed {
  return {
    runId: "run-1",
    threadId: "thread-1",
    event: event(),
    principal: principal(),
    projection: projection(),
    budget: normalBudget,
    directNodeIds: [],
    ...overrides,
  };
}

function request(
  operation: AiDmContextRequest["operation"],
  view: AiDmContextRequest["view"],
  nodeIds: string[] = [],
  extra: Partial<AiDmContextRequest> = {},
): AiDmContextRequest {
  return {
    requestId: `request-${operation}-${view}`,
    runId: "run-1",
    operation,
    view,
    nodeIds,
    ...extra,
  };
}

function setup(markdown: string): {
  root: string;
  repository: CampaignSourceRepository;
  parser: CampaignMarkdownParser;
  graph: RevisionedContextGraph;
} {
  const root = fixtureRoot();
  writeFixture(root, "rooms/current.md", markdown);
  writeFixture(
    root,
    "rooms/next.md",
    "---\nid: ROOM-NEXT\n---\n\n## PLAYER-VISIBLE\n\nA safe hall.\n",
  );
  const repository = new CampaignSourceRepository([{ rootId: "campaign", path: root }]);
  const parser = new CampaignMarkdownParser(repository);
  const graph = new RevisionedContextGraph();
  graph.replaceDocument(parser.parse("campaign", "rooms/current.md"));
  graph.replaceDocument(parser.parse("campaign", "rooms/next.md"));
  return { root, repository, parser, graph };
}

void test("parses fail-closed semantic sections and creates conditional non-auto-follow NEXT-LOAD edges", () => {
  const { graph } = setup(`---
id: ROOM-CURRENT
title: Current Room
---

## PLAYER-VISIBLE

An open arch.

## OBSERVABLE

A bell rings after the threshold is crossed.

## GM-ONLY

The password is dragon-glass.

## Unmarked Notes

This must fail closed.

## NEXT-LOAD

- After crossing: [next room](next.md)
`);
  const records = graph.allRecords();
  const visible = records.find(({ sectionKind }) => sectionKind === "player-visible");
  const observable = records.find(({ sectionKind }) => sectionKind === "observable");
  const unclassified = records.find(
    ({ sectionKind, node }) => sectionKind === "unclassified" && node.title === "Unmarked Notes",
  );
  const root = records.find(({ node }) => node.title === "Current Room");
  assert.deepEqual(visible?.node.disclosureScope, { kind: "public" });
  assert.equal(observable?.node.activation.status, "conditional");
  assert.deepEqual(unclassified?.node.disclosureScope, { kind: "gm" });
  const edge = root?.edges.find(({ relation }) => relation === "next-load");
  assert.equal(edge?.explicitExpansionRequired, true);
  assert.match(edge?.conditionRef ?? "", /^activate:edge:/);
});

void test("rejects traversal and absolute NEXT-LOAD paths outside the configured root", () => {
  const root = fixtureRoot();
  const outside = join(root, "..", `outside-${Date.now()}.md`);
  writeFileSync(outside, "# outside", "utf8");
  writeFixture(root, "rooms/bad.md", "## NEXT-LOAD\n\n- [escape](../../outside.md)\n");
  const parser = new CampaignMarkdownParser(
    new CampaignSourceRepository([{ rootId: "campaign", path: root }]),
  );
  assert.throws(
    () => parser.parse("campaign", "rooms/bad.md"),
    (error: unknown) => error instanceof ContextError && error.code === "SOURCE_OUTSIDE_ROOT",
  );
});

void test("filters hidden search results and keeps resolver context out of presenter reads", () => {
  const { repository, graph } = setup(`---
id: ROOM-CURRENT
---

## PLAYER-VISIBLE

An ordinary stone arch.

## GM-ONLY

The dragon password opens the concealed vault.
`);
  const secret = graph.allRecords().find(({ sectionKind }) => sectionKind === "gm-only");
  assert.ok(secret);
  const fact: AiDmResolutionFact = {
    factId: "fact-1",
    runId: "run-1",
    sourceNodeRevisions: [{ nodeId: secret.node.nodeId, revision: secret.node.revision }],
    kind: "perceived-sound",
    value: { narration: "You hear a click behind the wall." },
    visibility: "player",
    declassificationPolicy: "reveal-to-initiator",
    policyRevision: "policy-1",
  };
  const service = new ContextService(graph, repository);
  service.startRun(seed({ resolutionFacts: [fact], resolverCanReadSecrets: true }));

  const hiddenSearch = service.execute(
    request("context_search", "presenter", [], { query: "dragon password" }),
  );
  assert.deepEqual(hiddenSearch.nodes, []);
  assert.equal(hiddenSearch.denialCode, undefined);

  const resolverSearch = service.execute(
    request("context_search", "resolver", [], { query: "dragon password" }),
  );
  assert.equal(
    resolverSearch.nodes.some(({ nodeId }) => nodeId === secret.node.nodeId),
    true,
  );

  const presenterSecret = service.execute(
    request("context_read", "presenter", [secret.node.nodeId]),
  );
  assert.equal(presenterSecret.denialCode, "CONTEXT_NOT_VISIBLE");
  assert.deepEqual(presenterSecret.nodes, []);

  const presenterFact = service.execute(
    request("context_read", "presenter", ["resolution:fact-1"]),
  );
  assert.equal(presenterFact.nodes.length, 1);
  assert.deepEqual(presenterFact.nodes[0]?.body, {
    narration: "You hear a click behind the wall.",
  });
});

void test("does not follow NEXT-LOAD edges without explicit activation and sanitizes presenter roots", () => {
  const { repository, graph } = setup(`---
id: ROOM-CURRENT
---

## GM-ONLY

The destination is concealed.

## NEXT-LOAD

- After the sealed threshold opens: [next room](next.md)
`);
  const current = graph
    .allRecords()
    .find(({ node }) => node.edges.some(({ relation }) => relation === "next-load"));
  const edge = current?.edges.find(({ relation }) => relation === "next-load");
  assert.ok(current && edge);

  const inactiveService = new ContextService(graph, repository);
  inactiveService.startRun(seed({ directNodeIds: [current.node.nodeId] }));
  const inactive = inactiveService.execute(
    request("context_expand", "resolver", [current.node.nodeId], {
      relation: "next-load",
      maxDepth: 1,
    }),
  );
  assert.deepEqual(inactive.nodes, []);

  const presenterRoot = inactiveService.execute(request("context_get_root", "presenter"));
  const presenterBody = presenterRoot.nodes[0]?.body as Record<string, unknown>;
  assert.deepEqual(presenterBody["directNodeIds"], []);
  assert.deepEqual((presenterBody["runtime"] as Record<string, unknown>)["sourceRevisions"], {});

  const activeService = new ContextService(graph, repository);
  activeService.startRun(seed({ activatedEdgeIds: [edge.edgeId] }));
  const active = activeService.execute(
    request("context_expand", "resolver", [current.node.nodeId], {
      relation: "next-load",
      maxDepth: 1,
    }),
  );
  assert.equal(
    active.nodes.some(({ nodeId }) => nodeId === edge.targetNodeId),
    true,
  );
});

void test("enforces cumulative node and read budgets and records exact receipts", () => {
  const { repository, graph } = setup(`## PLAYER-VISIBLE

First visible section.

## PLAYER-VISIBLE

Second visible section.
`);
  const visibleIds = graph
    .allRecords()
    .filter(({ sectionKind }) => sectionKind === "player-visible")
    .map(({ node }) => node.nodeId);
  const activeConditionRefs = visibleIds
    .map((nodeId) => graph.getRecord(nodeId)?.node.activation.conditionRef)
    .filter((condition): condition is string => Boolean(condition));
  const service = new ContextService(graph, repository, () => new Date("2026-09-29T18:01:00.000Z"));
  service.startRun(
    seed({
      budget: { ...normalBudget, maxReads: 1, maxNodes: 1 },
      resolverCanReadSecrets: false,
      activeConditionRefs,
    }),
  );
  const first = service.execute(request("context_read", "presenter", visibleIds));
  assert.equal(first.nodes.length, 1);
  assert.equal(first.partial, true);
  assert.equal(first.denialCode, "CONTEXT_BUDGET_EXCEEDED");
  const second = service.execute(
    request("context_read", "presenter", [visibleIds[0] ?? "missing"]),
  );
  assert.equal(second.denialCode, "CONTEXT_BUDGET_EXCEEDED");
  const receipt = service.receipt("run-1");
  assert.equal(receipt.readsUsed, 1);
  assert.equal(receipt.nodesUsed, 1);
  assert.equal(receipt.entries.length, 1);
  assert.equal(receipt.budgetExhausted, true);
});

void test("invalidates a derived summary when a source dependency revision changes", () => {
  const { root, parser, graph } = setup("## PLAYER-VISIBLE\n\nThe first description.\n");
  const source = graph.allRecords().find(({ sectionKind }) => sectionKind === "player-visible");
  assert.ok(source);
  const summary = graph.addDerivedSummary({
    nodeId: "summary-1",
    title: "Summary",
    body: { text: "A concise description." },
    dependencies: [{ nodeId: source.node.nodeId, revision: source.node.revision }],
    generatorRevision: "generator-1",
  });
  assert.equal(graph.getRecord(summary.nodeId)?.node.stale, false);
  writeFixture(root, "rooms/current.md", "## PLAYER-VISIBLE\n\nThe changed description.\n");
  graph.replaceDocument(parser.parse("campaign", "rooms/current.md"));
  assert.equal(graph.getRecord(summary.nodeId)?.node.stale, true);
});

void test("signs capsules and rejects tampering, stale dependencies, and response-chain material", () => {
  const signer = new ContinuationCapsuleSigner("0123456789abcdef0123456789abcdef");
  const capsule = signer.mint({
    capsuleId: "capsule-1",
    threadId: "thread-1",
    worldId: "world-1",
    principalUserId: "player-1",
    disclosureScope: { kind: "users", userIds: ["player-1"] },
    priorRunId: "run-0",
    priorEventId: "event-0",
    createdAt: "2026-09-29T18:00:00.000Z",
    expiresAt: "2026-09-29T19:00:00.000Z",
    visibility: "player",
    summary: "The player reached the arch.",
    unresolvedReferences: ["choice:arch"],
    sourceNodeRevisions: [{ nodeId: "state-1", revision: "revision-1" }],
  });
  const expectation: ScopeExpectation = {
    worldId: "world-1",
    threadId: "thread-1",
    principalUserId: "player-1",
    disclosureScope: { kind: "users", userIds: ["player-1"] },
    isGm: false,
    now: new Date("2026-09-29T18:30:00.000Z"),
  };
  assert.equal(
    signer.validate(capsule, expectation, (nodeId) =>
      nodeId === "state-1" ? "revision-1" : undefined,
    ).capsuleId,
    "capsule-1",
  );
  assert.throws(
    () => signer.validate({ ...capsule, summary: "tampered" }, expectation, () => "revision-1"),
    (error: unknown) => error instanceof ContextError && error.code === "CAPSULE_STALE",
  );
  assert.throws(
    () => signer.validate(capsule, expectation, () => "revision-2"),
    (error: unknown) => error instanceof ContextError && error.code === "CAPSULE_STALE",
  );
  assert.throws(
    () => signer.mint({ ...capsule, summary: "Continue resp_abcdef123456" }),
    (error: unknown) => error instanceof ContextError && error.code === "CAPSULE_STALE",
  );
});

void test("builds identical root manifests from identical authoritative projections and rejects spoofed binding", () => {
  const root = fixtureRoot();
  writeFixture(root, "state.md", "## PLAYER-VISIBLE\n\nSafe.\n");
  const repository = new CampaignSourceRepository([{ rootId: "campaign", path: root }]);
  const graph = new RevisionedContextGraph();
  const first = new ContextService(graph, repository);
  const second = new ContextService(graph, repository);
  const firstRoot = first.startRun(seed());
  const secondRoot = second.startRun(seed());
  assert.equal(firstRoot.revision, secondRoot.revision);
  assert.throws(() =>
    new ContextService(graph, repository).startRun(
      seed({ projection: { ...projection(), authoritativeUserId: "spoofed-user" } }),
    ),
  );
});
