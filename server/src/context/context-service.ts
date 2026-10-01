import type {
  AiDmAccessScope,
  AiDmContextNode,
  AiDmContextReceipt,
  AiDmContextReceiptEntry,
  AiDmContextRequest,
  AiDmContextResult,
  AiDmResolutionFact,
  AiDmVisibility,
} from "@foundry-ai-dungeon-master/shared";

import { RevisionedContextGraph } from "./context-graph.js";
import { revisionOf } from "./hash.js";
import { buildDeterministicRoot } from "./root-projector.js";
import type {
  ContextNodeRecord,
  ContextRunSeed,
  ContextRunState,
  ContextSourceReader,
} from "./types.js";
import { ContextError } from "./types.js";
import { contextAccessDecision } from "./visibility-policy.js";

function operationName(
  operation: AiDmContextRequest["operation"],
): AiDmContextReceiptEntry["operation"] {
  const names = {
    context_get_root: "root",
    context_read: "read",
    context_expand: "expand",
    context_search: "search",
    context_get_changes: "changes",
    context_get_source: "source",
  } as const;
  return names[operation];
}

function requestedAudienceScope(seed: ContextRunSeed): AiDmAccessScope {
  const requested = seed.event.requestedAudience;
  if (requested.kind === "table") return { kind: "public" };
  if (requested.kind === "gm") return { kind: "gm" };
  if (requested.kind === "selected-users") {
    return { kind: "users", userIds: [...new Set(requested.recipientUserIds)].sort() };
  }
  return { kind: "users", userIds: [seed.principal.userId] };
}

function factRecord(
  fact: AiDmResolutionFact,
  seed: ContextRunSeed,
  stale: boolean,
): ContextNodeRecord {
  let scope: AiDmAccessScope = { kind: "gm" };
  let visibility: AiDmVisibility = "secret";
  if (fact.declassificationPolicy === "reveal-to-initiator") {
    scope = { kind: "users", userIds: [seed.principal.userId] };
    visibility = "player";
  } else if (fact.declassificationPolicy === "reveal-to-audience") {
    scope = requestedAudienceScope(seed);
    visibility = scope.kind === "public" ? "public" : scope.kind === "gm" ? "gm" : "player";
  }
  const node: AiDmContextNode = {
    nodeId: `resolution:${fact.factId}`,
    kind: "derived-summary",
    revision: revisionOf(fact),
    authoritative: false,
    authority: "operational",
    readScope: scope,
    disclosureScope: scope,
    activation: { status: "active", conditionRef: null },
    title: `Resolved fact: ${fact.kind}`,
    contentType: "application/json",
    body: structuredClone(fact.value),
    sourceUri: null,
    sourceHash: null,
    sourceSpan: null,
    edges: [],
    dependencies: structuredClone(fact.sourceNodeRevisions),
    stale,
  };
  return { node, visibility, sectionKind: "unclassified", edges: [] };
}

function estimatedTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function nodeCharacters(node: AiDmContextNode): number {
  return node.title.length + JSON.stringify(node.body).length;
}

export class ContextService {
  private readonly runs = new Map<string, ContextRunState>();
  private readonly runFacts = new Map<string, Map<string, ContextNodeRecord>>();

  constructor(
    readonly graph: RevisionedContextGraph,
    private readonly sourceReader: ContextSourceReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  startRun(seed: ContextRunSeed): AiDmContextNode {
    if (this.runs.has(seed.runId)) throw new Error(`Context run ${seed.runId} already exists.`);
    for (const [key, value] of Object.entries(seed.budget)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid context budget ${key}.`);
    }
    const built = buildDeterministicRoot(seed);
    const facts = new Map<string, ContextNodeRecord>();
    for (const fact of seed.resolutionFacts ?? []) {
      if (fact.runId !== seed.runId)
        throw new Error(`Resolution fact ${fact.factId} belongs to another run.`);
      const stale = fact.sourceNodeRevisions.some(
        (dependency) =>
          this.graph.getRecord(dependency.nodeId)?.node.revision !== dependency.revision,
      );
      const record = factRecord(fact, seed, stale);
      facts.set(record.node.nodeId, record);
    }
    this.runFacts.set(seed.runId, facts);
    this.runs.set(seed.runId, {
      seed: structuredClone(seed),
      root: built.record.node,
      activeConditionRefs: new Set(seed.activeConditionRefs ?? []),
      activatedEdgeIds: new Set(seed.activatedEdgeIds ?? []),
      resolutionFacts: structuredClone(seed.resolutionFacts ?? []),
      receipt: {
        entries: [],
        readsUsed: 0,
        nodeKeys: new Set(),
        charactersUsed: 0,
        estimatedTokensUsed: 0,
        maximumDepthUsed: 0,
        budgetExhausted: false,
      },
    });
    return structuredClone(built.record.node);
  }

  execute(request: AiDmContextRequest): AiDmContextResult {
    const run = this.requireRun(request.runId);
    if (request.nodeIds.length > 64)
      throw new Error("A context request may name at most 64 nodes.");
    if (request.operation !== "context_get_root") {
      if (run.receipt.readsUsed >= run.seed.budget.maxReads) {
        run.receipt.budgetExhausted = true;
        return this.result(request, [], true, "CONTEXT_BUDGET_EXCEEDED");
      }
      run.receipt.readsUsed += 1;
    }

    switch (request.operation) {
      case "context_get_root":
        return this.collect(request, run, [this.rootForView(run, request)], 0);
      case "context_read":
        return this.read(request, run);
      case "context_expand":
        return this.expand(request, run);
      case "context_search":
        return this.search(request, run);
      case "context_get_changes":
        return this.changes(request, run);
      case "context_get_source":
        return this.source(request, run);
    }
  }

  receipt(runId: string): AiDmContextReceipt {
    const run = this.requireRun(runId);
    const completedAt = this.now().toISOString();
    const base = {
      runId,
      contextGraphRevision: this.graph.revision,
      entries: structuredClone(run.receipt.entries),
      readsUsed: run.receipt.readsUsed,
      nodesUsed: run.receipt.nodeKeys.size,
      charactersUsed: run.receipt.charactersUsed,
      estimatedTokensUsed: run.receipt.estimatedTokensUsed,
      maximumDepthUsed: run.receipt.maximumDepthUsed,
      budgetExhausted: run.receipt.budgetExhausted,
      completedAt,
    };
    return { receiptId: `receipt:${revisionOf(base).slice(0, 32)}`, ...base };
  }

  private read(request: AiDmContextRequest, run: ContextRunState): AiDmContextResult {
    const nodes: AiDmContextNode[] = [];
    let denied = false;
    let stale = false;
    for (const nodeId of request.nodeIds) {
      const record = this.recordForRun(run, nodeId);
      if (!record) {
        denied = true;
        continue;
      }
      if (record.node.stale) {
        stale = true;
        continue;
      }
      if (!this.canAccess(record, request, run)) {
        denied = true;
        continue;
      }
      nodes.push(record.node);
    }
    return this.collect(
      request,
      run,
      nodes,
      0,
      stale ? "CONTEXT_STALE" : denied && nodes.length === 0 ? "CONTEXT_NOT_VISIBLE" : undefined,
    );
  }

  private expand(request: AiDmContextRequest, run: ContextRunState): AiDmContextResult {
    const requestedDepth = request.maxDepth ?? 1;
    if (!Number.isInteger(requestedDepth) || requestedDepth < 1) {
      throw new Error("Context expansion depth must be a positive integer.");
    }
    const maxDepth = Math.min(requestedDepth, run.seed.budget.maxDepth);
    const queue = request.nodeIds.map((nodeId) => ({ nodeId, depth: 0 }));
    const visited = new Set(request.nodeIds);
    const nodes: AiDmContextNode[] = [];
    let partial = requestedDepth > maxDepth;
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;
      const source = this.recordForRun(run, current.nodeId);
      if (!source || !this.canAccess(source, request, run)) continue;
      for (const edge of source.edges) {
        if (request.relation && edge.relation !== request.relation) continue;
        if (
          edge.explicitExpansionRequired &&
          !run.activatedEdgeIds.has(edge.edgeId) &&
          (!edge.conditionRef || !run.activeConditionRefs.has(edge.conditionRef))
        ) {
          continue;
        }
        if (visited.has(edge.targetNodeId)) continue;
        visited.add(edge.targetNodeId);
        const target = this.recordForRun(run, edge.targetNodeId);
        if (!target || target.node.stale || !this.canAccess(target, request, run)) continue;
        const depth = current.depth + 1;
        nodes.push(target.node);
        queue.push({ nodeId: target.node.nodeId, depth });
        run.receipt.maximumDepthUsed = Math.max(run.receipt.maximumDepthUsed, depth);
      }
    }
    const result = this.collect(request, run, nodes, run.receipt.maximumDepthUsed);
    partial ||= result.partial;
    return { ...result, partial };
  }

  private search(request: AiDmContextRequest, run: ContextRunState): AiDmContextResult {
    const query = request.query?.trim().toLowerCase() ?? "";
    if (!query || query.length > 256) throw new Error("Context search requires a bounded query.");
    const terms = query.split(/\s+/).filter(Boolean);
    const candidates = [
      ...this.graph.allRecords(),
      ...(this.runFacts.get(run.seed.runId)?.values() ?? []),
    ]
      .filter((record) => !record.node.stale && this.canAccess(record, request, run))
      .map((record) => {
        const title = record.node.title.toLowerCase();
        const body = JSON.stringify(record.node.body).toLowerCase();
        const score = terms.reduce(
          (total, term) => total + (title.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0),
          0,
        );
        return { record, score };
      })
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.record.node.nodeId.localeCompare(right.record.node.nodeId),
      )
      .map(({ record }) => record.node);
    return this.collect(request, run, candidates, 0);
  }

  private changes(request: AiDmContextRequest, run: ContextRunState): AiDmContextResult {
    const sinceRevision = request.query?.trim();
    if (!sinceRevision)
      throw new Error("Context changes requires a prior graph revision in query.");
    const nodes = this.graph
      .changedNodeIds(sinceRevision)
      .map((nodeId) => this.graph.getRecord(nodeId))
      .filter((record): record is ContextNodeRecord => Boolean(record))
      .filter((record) => !record.node.stale && this.canAccess(record, request, run))
      .map(({ node }) => node);
    return this.collect(request, run, nodes, 0);
  }

  private source(request: AiDmContextRequest, run: ContextRunState): AiDmContextResult {
    const nodeId = request.nodeIds[0];
    if (request.nodeIds.length !== 1 || !nodeId || !request.sourceSpan) {
      throw new Error("Context source reads require exactly one node and an explicit source span.");
    }
    const record = this.recordForRun(run, nodeId);
    if (!record || !this.canAccess(record, request, run)) {
      return this.result(request, [], false, "CONTEXT_NOT_VISIBLE");
    }
    if (record.node.stale) return this.result(request, [], false, "CONTEXT_STALE");
    const sourceUri = record.node.sourceUri;
    const allowedSpan = record.node.sourceSpan;
    if (
      !sourceUri ||
      !allowedSpan ||
      request.sourceSpan.startLine < allowedSpan.startLine ||
      request.sourceSpan.endLine > allowedSpan.endLine
    ) {
      return this.result(request, [], false, "SOURCE_NOT_ALLOWED");
    }
    const excerpt = this.sourceReader.readSource(sourceUri, request.sourceSpan);
    const node: AiDmContextNode = {
      nodeId: `excerpt:${revisionOf({ nodeId, span: excerpt.span, hash: excerpt.sourceHash }).slice(0, 32)}`,
      kind: "derived-summary",
      revision: revisionOf(excerpt),
      authoritative: false,
      authority: "derived",
      readScope: structuredClone(record.node.readScope),
      disclosureScope: structuredClone(record.node.disclosureScope),
      activation: structuredClone(record.node.activation),
      title: `Source excerpt for ${record.node.title}`,
      contentType: "text/markdown",
      body: { text: excerpt.text },
      sourceUri,
      sourceHash: excerpt.sourceHash,
      sourceSpan: excerpt.span,
      edges: [],
      dependencies: [{ nodeId: record.node.nodeId, revision: record.node.revision }],
      stale: false,
    };
    this.runFacts.get(run.seed.runId)?.set(node.nodeId, {
      node: structuredClone(node),
      visibility: record.visibility,
      sectionKind: "source-provenance",
      edges: [],
    });
    return this.collect(request, run, [node], 0);
  }

  private rootForView(run: ContextRunState, request: AiDmContextRequest): AiDmContextNode {
    if (request.view === "resolver") return structuredClone(run.root);
    const allowedIds = run.seed.directNodeIds
      .filter((nodeId) => {
        const record = this.recordForRun(run, nodeId);
        return record ? this.canAccess(record, request, run) : false;
      })
      .sort();
    const body = structuredClone(run.root.body) as Record<string, unknown>;
    body["directNodeIds"] = allowedIds;
    body["synchronizationConflicts"] = [];
    const runtime = body["runtime"];
    if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
      (runtime as Record<string, unknown>)["sourceRevisions"] = {};
    }
    const sanitized: AiDmContextNode = {
      ...structuredClone(run.root),
      body: body as AiDmContextNode["body"],
      edges: run.root.edges.filter(({ targetNodeId }) => allowedIds.includes(targetNodeId)),
    };
    sanitized.revision = revisionOf({
      resolverRootRevision: run.root.revision,
      body: sanitized.body,
      edges: sanitized.edges,
    });
    return sanitized;
  }

  private collect(
    request: AiDmContextRequest,
    run: ContextRunState,
    candidates: readonly AiDmContextNode[],
    depth: number,
    denialCode?: AiDmContextResult["denialCode"],
  ): AiDmContextResult {
    const nodes: AiDmContextNode[] = [];
    let partial = false;
    for (const node of candidates) {
      const key = `${node.nodeId}\0${node.revision}`;
      const characterCount = nodeCharacters(node);
      const tokenCount = estimatedTokens(characterCount);
      const newNode = !run.receipt.nodeKeys.has(key);
      if (
        (newNode && run.receipt.nodeKeys.size + 1 > run.seed.budget.maxNodes) ||
        run.receipt.charactersUsed + characterCount > run.seed.budget.maxCharacters ||
        run.receipt.estimatedTokensUsed + tokenCount > run.seed.budget.maxEstimatedTokens
      ) {
        partial = true;
        run.receipt.budgetExhausted = true;
        denialCode = "CONTEXT_BUDGET_EXCEEDED";
        break;
      }
      nodes.push(structuredClone(node));
      run.receipt.nodeKeys.add(key);
      run.receipt.charactersUsed += characterCount;
      run.receipt.estimatedTokensUsed += tokenCount;
      run.receipt.maximumDepthUsed = Math.max(run.receipt.maximumDepthUsed, depth);
      run.receipt.entries.push({
        nodeId: node.nodeId,
        revision: node.revision,
        operation: operationName(request.operation),
        visibilityApplied: this.visibilityFor(run, node.nodeId),
      });
    }
    return this.result(request, nodes, partial, denialCode);
  }

  private result(
    request: AiDmContextRequest,
    nodes: AiDmContextNode[],
    partial: boolean,
    denialCode?: AiDmContextResult["denialCode"],
  ): AiDmContextResult {
    return {
      requestId: request.requestId,
      operation: request.operation,
      nodes,
      partial,
      ...(denialCode ? { denialCode } : {}),
    };
  }

  private canAccess(
    record: ContextNodeRecord,
    request: AiDmContextRequest,
    run: ContextRunState,
  ): boolean {
    return this.canAccessRecord(record, request, run, new Set());
  }

  private canAccessRecord(
    record: ContextNodeRecord,
    request: AiDmContextRequest,
    run: ContextRunState,
    visiting: Set<string>,
  ): boolean {
    if (visiting.has(record.node.nodeId)) return false;
    const allowed = contextAccessDecision(record, {
      view: request.view,
      principal: {
        runPrincipal: run.seed.principal,
        resolverCanReadSecrets: run.seed.resolverCanReadSecrets ?? true,
        ...(run.seed.presenterAudienceScope
          ? { presenterAudienceScope: run.seed.presenterAudienceScope }
          : {}),
      },
      activeConditionRefs: run.activeConditionRefs,
    }).allowed;
    if (!allowed) return false;
    if (request.view !== "presenter" || record.node.authority !== "derived") return true;
    visiting.add(record.node.nodeId);
    return record.node.dependencies.every((dependency) => {
      const source = this.recordForRun(run, dependency.nodeId);
      return (
        source?.node.revision === dependency.revision &&
        this.canAccessRecord(source, request, run, new Set(visiting))
      );
    });
  }

  private recordForRun(run: ContextRunState, nodeId: string): ContextNodeRecord | undefined {
    if (nodeId === run.root.nodeId) {
      return {
        node: structuredClone(run.root),
        visibility: run.seed.principal.isGm ? "gm" : "player",
        sectionKind: "unclassified",
        edges: run.root.edges.map((edge) => ({
          ...edge,
          edgeId: `root-edge:${revisionOf(edge.targetNodeId).slice(0, 24)}`,
          conditionRef: null,
          explicitExpansionRequired: false,
          sourceSpan: null,
        })),
      };
    }
    return this.runFacts.get(run.seed.runId)?.get(nodeId) ?? this.graph.getRecord(nodeId);
  }

  private visibilityFor(run: ContextRunState, nodeId: string): AiDmVisibility {
    return this.recordForRun(run, nodeId)?.visibility ?? "secret";
  }

  private requireRun(runId: string): ContextRunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown context run ${runId}.`);
    return run;
  }
}

export { ContextError };
