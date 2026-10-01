import { randomUUID } from "node:crypto";

import type {
  AiDmActionProposal,
  AiDmEffectiveAudience,
  AiDmExpectedRevision,
  AiDmJsonValue,
  AiDmRun,
} from "@foundry-ai-dungeon-master/shared";

import {
  CampaignMarkdownParser,
  CampaignSourceRepository,
  ContextService,
  ContinuationCapsuleSigner,
  RevisionedContextGraph,
  sourceNodeId,
} from "../context/index.js";
import { evaluateProposal, type AiDmPolicyCatalog } from "../policy/index.js";
import { AiDungeonMasterRunner, type AiDmProvider } from "../runner/index.js";
import type { AiDmOperationalStore } from "../storage/index.js";
import {
  ToolCatalogRunSession,
  type CatalogSnapshot,
  type TrustedToolCatalog,
} from "../tool-catalog/index.js";
import { AiDmRunBootstrapExecutor, type AiDmProposalCreator } from "./bootstrap-executor.js";
import type {
  AiDmExecutionHooks,
  AiDmRunExecutionResult,
  AiDmRunExecutor,
} from "./direct-prompt.js";

function object(value: AiDmJsonValue): Record<string, AiDmJsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Proposal arguments must be an object.");
  }
  return value;
}

function string(value: AiDmJsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value;
}

function expectedRevisions(value: AiDmJsonValue | undefined): AiDmExpectedRevision[] {
  if (!Array.isArray(value)) throw new Error("expectedRevisions must be an array.");
  return value.map((item) => {
    const record = object(item);
    return {
      provider: string(record["provider"], "provider"),
      resourceKind: string(record["resourceKind"], "resourceKind"),
      resourceId: string(record["resourceId"], "resourceId"),
      revision: string(record["revision"], "revision"),
    };
  });
}

function policyCatalog(snapshot: CatalogSnapshot): AiDmPolicyCatalog {
  return {
    catalogRevision: snapshot.catalogRevision,
    policyRevision: snapshot.policyVersion,
    get: (toolId) => {
      const record = snapshot.records.get(toolId);
      if (!record) return undefined;
      return {
        toolId,
        revision: record.descriptor.revision,
        schemaDigest: record.schemaDigest,
        effects: record.descriptor.effects,
        risk: record.descriptor.risk,
        approvalPolicy: record.descriptor.approvalPolicy,
        available: record.descriptor.availability === "available",
        requiredPermissions: record.descriptor.requiredPermissions,
        supportsExpectedRevision: record.metadata.guarantees.expectedRevision,
        supportsIdempotency: record.metadata.guarantees.idempotentCommit,
      };
    },
  };
}

function proposalCreator(
  store: AiDmOperationalStore,
  snapshot: CatalogSnapshot,
  proposals: AiDmActionProposal[],
  now: () => Date,
): AiDmProposalCreator {
  return {
    create: ({ run, arguments: argumentValue }) => {
      const args = object(argumentValue);
      const operationsValue = args["operations"];
      if (!Array.isArray(operationsValue)) throw new Error("Proposal operations are required.");
      const operations = operationsValue.map((value) => {
        const operation = object(value);
        return {
          operationId: randomUUID(),
          toolId: string(operation["toolId"], "toolId"),
          arguments: operation["arguments"] ?? {},
          expectedRevisions: expectedRevisions(operation["expectedRevisions"]),
        };
      });
      const createdAt = now();
      const outcome = evaluateProposal(
        {
          proposalId: `proposal-${randomUUID()}`,
          runId: run.runId,
          causeEventId: run.eventId,
          summary: string(args["summary"], "summary").slice(0, 2_000),
          expiresAt: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
          operations,
        },
        run.principal,
        policyCatalog(snapshot),
        createdAt.toISOString(),
      );
      if (outcome.decision === "refuse") throw new Error(`Proposal refused: ${outcome.code}.`);
      const proposal = store.createProposal(outcome.proposal).proposal;
      proposals.push(proposal);
      return Promise.resolve(proposal);
    },
  };
}

export interface ProductionRunExecutorOptions {
  store: AiDmOperationalStore;
  provider: AiDmProvider;
  model: string;
  catalog: TrustedToolCatalog;
  context: ContextService;
  directNodeIds: string[];
  contextForWorld?: (worldId: string) => { service: ContextService; directNodeIds: string[] };
  capsuleSigner: ContinuationCapsuleSigner;
  now?: () => Date;
}

export class ProductionRunExecutor implements AiDmRunExecutor {
  readonly #now: () => Date;

  constructor(private readonly options: ProductionRunExecutorOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  async execute(input: {
    run: AiDmRun;
    event: import("@foundry-ai-dungeon-master/shared").AiDmNormalizedEvent;
    projection: import("@foundry-ai-dungeon-master/shared").AiDmRuntimeProjection;
    effectiveAudience: AiDmEffectiveAudience;
    signal: AbortSignal;
    hooks: AiDmExecutionHooks;
  }): Promise<AiDmRunExecutionResult> {
    const snapshot = await this.options.catalog.refresh();
    const gmOnlyResolution =
      input.effectiveAudience.scope.kind === "gm" ||
      (input.effectiveAudience.scope.kind === "users" &&
        input.run.principal.isGm &&
        input.effectiveAudience.scope.userIds.length === 1 &&
        input.effectiveAudience.scope.userIds[0] === input.run.principal.userId);
    const context = this.options.contextForWorld?.(input.run.principal.worldId) ?? {
      service: this.options.context,
      directNodeIds: this.options.directNodeIds,
    };
    const root = context.service.startRun({
      runId: input.run.runId,
      threadId: input.run.threadId,
      event: input.event,
      principal: input.run.principal,
      projection: input.projection,
      budget: input.run.budgets.context,
      directNodeIds: context.directNodeIds,
      activeConditionRefs: [
        ...(input.projection.activeSceneId ? [`scene:${input.projection.activeSceneId}`] : []),
        ...input.projection.controlledTokenIds.map((id) => `token:${id}`),
      ],
      resolverCanReadSecrets: gmOnlyResolution,
      presenterAudienceScope: input.effectiveAudience.scope,
    });
    const session = new ToolCatalogRunSession(this.options.catalog, {
      runId: input.run.runId,
      principal: input.run.principal,
      budgets: {
        maxSearches: input.run.budgets.maxToolSearches,
        maxLoadedDefinitions: input.run.budgets.maxLoadedDefinitions,
        maxToolCalls: input.run.budgets.maxToolCalls,
      },
    });
    const proposals: AiDmActionProposal[] = [];
    const tools = new AiDmRunBootstrapExecutor(
      context.service,
      session,
      proposalCreator(this.options.store, snapshot, proposals, this.#now),
      gmOnlyResolution ? "resolver" : "presenter",
    );
    const runner = new AiDungeonMasterRunner({
      provider: this.options.provider,
      toolExecutor: tools,
      model: this.options.model,
      hooks: {
        onStatus: (status) => input.hooks.status(status),
        onOutputDelta: (delta) => input.hooks.output(delta),
        onProviderResponse: (responseId) => input.hooks.providerResponse(responseId),
      },
    });
    const result = await runner.run(
      input.run,
      {
        event: input.event,
        projection: input.projection,
        rootManifest: root.body,
        continuationCapsule: null,
      },
      input.signal,
    );
    for (const search of tools.searchResults) {
      this.options.store.recordToolSearch(input.run.runId, search, this.#now().toISOString());
    }
    for (const definition of tools.loadedDefinitions) {
      this.options.store.recordLoadedToolDefinition(definition);
    }
    const receipt = context.service.receipt(input.run.runId);
    const dependencyMap = new Map(
      receipt.entries.map(({ nodeId, revision }) => [nodeId, { nodeId, revision }]),
    );
    const createdAt = this.#now();
    const capsule = this.options.capsuleSigner.mint({
      capsuleId: `capsule-${randomUUID()}`,
      threadId: input.run.threadId,
      worldId: input.run.principal.worldId,
      principalUserId: input.run.principal.userId,
      disclosureScope: input.effectiveAudience.scope,
      priorRunId: input.run.runId,
      priorEventId: input.event.eventId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60_000).toISOString(),
      visibility:
        input.effectiveAudience.scope.kind === "public"
          ? "public"
          : input.effectiveAudience.scope.kind === "gm"
            ? "gm"
            : "player",
      summary: result.finalText.slice(0, 4_096),
      unresolvedReferences: [],
      sourceNodeRevisions: [...dependencyMap.values()].slice(0, 32),
    });
    return { finalText: result.finalText, receipt, capsule, proposals };
  }
}

export function createCampaignContext(campaignRoot?: string): {
  service: ContextService;
  directNodeIds: string[];
} {
  if (!campaignRoot)
    return {
      service: new ContextService(new RevisionedContextGraph(), {
        readSource: () => {
          throw new Error("No active-world campaign source available");
        },
      }),
      directNodeIds: [],
    };
  const repository = new CampaignSourceRepository([{ rootId: "campaign", path: campaignRoot }]);
  const parser = new CampaignMarkdownParser(repository);
  const graph = new RevisionedContextGraph();
  const seeds = ["campaign-state.md"];
  const loaded: string[] = [];
  for (const path of seeds) {
    try {
      graph.replaceDocument(parser.parse("campaign", path));
      loaded.push(path);
    } catch {
      /* Missing campaign state is unavailable, never a workspace fallback. */
    }
  }
  return {
    service: new ContextService(graph, repository),
    directNodeIds: loaded.map((path) => sourceNodeId("campaign", path)),
  };
}
