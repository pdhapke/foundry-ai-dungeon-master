import { randomUUID } from "node:crypto";

import type {
  AiDmJsonValue,
  AiDmLoadedToolDefinition,
  AiDmToolDenial,
  AiDmToolEffect,
  AiDmToolGrant,
  AiDmToolSearchRequest,
  AiDmToolSearchResult,
} from "@foundry-ai-dungeon-master/shared";

import { digestJson } from "./canonical.js";
import { metadataAllows, TrustedToolCatalog } from "./catalog.js";
import { searchCatalog } from "./search.js";
import type {
  CatalogToolRecord,
  LoadedToolGrant,
  ToolCatalogClock,
  ToolCatalogIds,
  ToolCatalogOutcome,
  ToolCatalogSessionOptions,
  ToolCommitAuthorizer,
  ToolExecutionReceipt,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolLoadReceipt,
  ToolSearchReceipt,
} from "./types.js";
import { validateArguments } from "./validation.js";

const DEFAULT_GRANT_TTL_MS = 5 * 60_000;

const systemClock: ToolCatalogClock = { now: () => new Date() };
const randomIds: ToolCatalogIds = {
  nextId: (prefix) => `${prefix}:${randomUUID()}`,
};
const denyCommits: ToolCommitAuthorizer = { authorize: () => Promise.resolve(false) };

function denial(
  toolId: string | null,
  code: AiDmToolDenial["code"],
  message: string,
  retryable = false,
): ToolCatalogOutcome<never> {
  return { ok: false, denial: { toolId, code, message, retryable } };
}

function allowedEffects(record: CatalogToolRecord): AiDmToolEffect[] {
  return record.metadata.effects.filter((effect) => {
    if (effect !== "commit") return true;
    return (
      record.metadata.approvalPolicy !== "always-refuse" &&
      record.metadata.guarantees.expectedRevision &&
      record.metadata.guarantees.idempotentCommit
    );
  });
}

function isConsequential(record: CatalogToolRecord): boolean {
  return record.descriptor.risk === "consequential" || record.descriptor.risk === "destructive";
}

export class ToolCatalogRunSession {
  private readonly searches = new Map<string, Set<string>>();
  private readonly grants = new Map<string, AiDmToolGrant>();
  private readonly loadedByTool = new Map<string, LoadedToolGrant>();
  private readonly idempotencyResults = new Map<
    string,
    { argumentsDigest: string; result: AiDmJsonValue }
  >();
  private searchesUsed = 0;
  private definitionsLoaded = 0;
  private callsUsed = 0;
  readonly searchReceipts: ToolSearchReceipt[] = [];
  readonly loadReceipts: ToolLoadReceipt[] = [];
  readonly executionReceipts: ToolExecutionReceipt[] = [];

  constructor(
    private readonly catalog: TrustedToolCatalog,
    readonly options: ToolCatalogSessionOptions,
    private readonly clock: ToolCatalogClock = systemClock,
    private readonly ids: ToolCatalogIds = randomIds,
    private readonly commitAuthorizer: ToolCommitAuthorizer = denyCommits,
  ) {}

  search(request: AiDmToolSearchRequest): ToolCatalogOutcome<AiDmToolSearchResult> {
    if (this.searchesUsed >= this.options.budgets.maxSearches) {
      return denial(null, "TOOL_BUDGET_EXCEEDED", "The run's tool-search budget is exhausted.");
    }
    const query = request.query.trim();
    if (query.length === 0 || request.limit < 1 || request.limit > 100) {
      return denial(null, "TOOL_ARGUMENT_INVALID", "Tool search requires a query and limit 1-100.");
    }
    this.searchesUsed += 1;
    const snapshot = this.catalog.snapshot();
    const policyViewRevision = this.catalog.policyViewRevision(this.options.principal);
    const searchId = this.ids.nextId("search");
    const ranked = searchCatalog(
      this.catalog.searchableRecords(this.options.principal),
      { ...request, query },
      snapshot.catalogRevision,
      policyViewRevision,
      searchId,
    );
    this.searches.set(
      searchId,
      new Set(ranked.result.descriptors.map((descriptor) => descriptor.toolId)),
    );
    this.searchReceipts.push({
      searchId,
      runId: this.options.runId,
      principalUserId: this.options.principal.userId,
      query,
      normalizedTerms: ranked.normalizedTerms,
      catalogRevision: snapshot.catalogRevision,
      policyViewRevision,
      returnedToolIds: ranked.result.descriptors.map((descriptor) => descriptor.toolId),
      scores: Object.fromEntries(
        ranked.result.descriptors.map(({ toolId }) => [toolId, ranked.scores.get(toolId) ?? 0]),
      ),
      occurredAt: this.clock.now().toISOString(),
    });
    return { ok: true, value: ranked.result };
  }

  load(searchId: string, toolId: string): ToolCatalogOutcome<LoadedToolGrant> {
    const returned = this.searches.get(searchId);
    if (!returned?.has(toolId)) {
      return denial(toolId, "TOOL_UNKNOWN", "The tool was not returned by this run's search.");
    }
    const existing = this.loadedByTool.get(toolId);
    if (existing) return { ok: true, value: existing };
    if (this.definitionsLoaded >= this.options.budgets.maxLoadedDefinitions) {
      return denial(
        toolId,
        "TOOL_BUDGET_EXCEEDED",
        "The run's loaded-definition budget is exhausted.",
      );
    }
    const snapshot = this.catalog.snapshot();
    const record = snapshot.records.get(toolId);
    if (!record) return denial(toolId, "TOOL_UNKNOWN", "The tool is not in the trusted catalog.");
    if (record.descriptor.availability !== "available") {
      return denial(toolId, "TOOL_UNAVAILABLE", "The tool is currently unavailable.", true);
    }
    if (!metadataAllows(this.options.principal, record.metadata, "discover")) {
      return denial(toolId, "TOOL_UNAUTHORIZED", "The tool is not permitted for this run.");
    }

    const now = this.clock.now();
    const policyViewRevision = this.catalog.policyViewRevision(this.options.principal);
    const grantId = this.ids.nextId("grant");
    const definition: AiDmLoadedToolDefinition = {
      runId: this.options.runId,
      searchId,
      toolId,
      revision: record.descriptor.revision,
      catalogRevision: snapshot.catalogRevision,
      inputSchema: structuredClone(record.definition.inputSchema),
      outputSchema: structuredClone(record.definition.outputSchema),
      schemaDigest: record.schemaDigest,
      loadedAt: now.toISOString(),
      risk: record.descriptor.risk,
      approvalPolicy: record.descriptor.approvalPolicy,
      policyRevision: snapshot.policyVersion,
    };
    const grant: AiDmToolGrant = {
      grantId,
      runId: this.options.runId,
      principalUserId: this.options.principal.userId,
      toolId,
      toolRevision: record.descriptor.revision,
      catalogRevision: snapshot.catalogRevision,
      policyViewRevision,
      schemaDigest: record.schemaDigest,
      allowedEffects: allowedEffects(record),
      remainingCalls: this.options.budgets.maxToolCalls - this.callsUsed,
      expiresAt: new Date(
        now.getTime() + (this.options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS),
      ).toISOString(),
    };
    const loaded = { definition, grant };
    this.definitionsLoaded += 1;
    this.grants.set(grantId, grant);
    this.loadedByTool.set(toolId, loaded);
    this.loadReceipts.push({
      loadId: this.ids.nextId("load"),
      runId: this.options.runId,
      searchId,
      toolId,
      toolRevision: record.descriptor.revision,
      schemaDigest: record.schemaDigest,
      grantId,
      catalogRevision: snapshot.catalogRevision,
      policyViewRevision,
      occurredAt: now.toISOString(),
    });
    return { ok: true, value: loaded };
  }

  async executeGrant(
    request: ToolExecutionRequest,
  ): Promise<ToolCatalogOutcome<ToolExecutionResult>> {
    const grant = this.grants.get(request.grantId);
    if (!grant || grant.runId !== this.options.runId) {
      return denial(null, "TOOL_UNKNOWN", "The run-scoped tool grant is unknown.");
    }
    const toolId = grant.toolId;
    const now = this.clock.now();
    const argumentsDigest = digestJson(request.arguments);
    const receiptBase = {
      executionId: this.ids.nextId("execution"),
      runId: this.options.runId,
      grantId: request.grantId,
      toolId,
      effect: request.effect,
      argumentsDigest,
      idempotencyKey: request.commitAuthorization?.idempotencyKey ?? null,
      occurredAt: now.toISOString(),
    };
    const deny = (
      code: AiDmToolDenial["code"],
      message: string,
      retryable = false,
    ): ToolCatalogOutcome<ToolExecutionResult> => {
      this.executionReceipts.push({ ...receiptBase, outcome: "denied" });
      return denial(toolId, code, message, retryable);
    };

    if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
      return deny("TOOL_GRANT_EXPIRED", "The run-scoped tool grant has expired.", true);
    }
    let snapshot;
    try {
      snapshot = await this.catalog.refresh();
    } catch {
      return deny("TOOL_UNAVAILABLE", "The tool provider could not be revalidated.", true);
    }
    if (snapshot.catalogRevision !== grant.catalogRevision) {
      return deny(
        "TOOL_CATALOG_STALE",
        "The tool catalog changed after this grant was issued.",
        true,
      );
    }
    if (this.catalog.policyViewRevision(this.options.principal) !== grant.policyViewRevision) {
      return deny(
        "TOOL_UNAUTHORIZED",
        "The run's permission view changed after tool loading.",
        true,
      );
    }
    const record = snapshot.records.get(toolId);
    if (!record || record.descriptor.availability !== "available") {
      return deny("TOOL_UNAVAILABLE", "The selected tool is no longer available.", true);
    }
    if (!metadataAllows(this.options.principal, record.metadata, "execute")) {
      return deny("TOOL_UNAUTHORIZED", "The principal cannot execute the selected tool.");
    }
    if (
      grant.toolRevision !== record.descriptor.revision ||
      grant.schemaDigest !== record.schemaDigest
    ) {
      return deny("TOOL_SCHEMA_CHANGED", "The selected tool definition changed.", true);
    }
    if (!grant.allowedEffects.includes(request.effect)) {
      const message =
        request.effect === "commit" && isConsequential(record)
          ? "Commit is refused because the provider lacks revision and idempotency guarantees."
          : "The grant does not authorize the requested effect.";
      return deny("TOOL_UNAUTHORIZED", message);
    }
    const validationErrors = validateArguments(record.definition.inputSchema, request.arguments);
    if (validationErrors.length > 0) {
      return deny("TOOL_ARGUMENT_INVALID", validationErrors[0] ?? "Invalid tool arguments.");
    }

    if (request.effect === "propose" || (isConsequential(record) && request.effect !== "commit")) {
      this.executionReceipts.push({ ...receiptBase, outcome: "proposed" });
      return {
        ok: true,
        value: {
          kind: "proposal-required",
          toolId,
          arguments: structuredClone(request.arguments),
          approvalPolicy: record.descriptor.approvalPolicy,
          reason: "Consequential provider operations resolve to proposals before mutation.",
        },
      };
    }

    if (request.effect === "commit") {
      const authorization = request.commitAuthorization;
      if (
        !authorization ||
        authorization.expectedRevisionCount < 1 ||
        !authorization.idempotencyKey ||
        !(await this.commitAuthorizer.authorize({
          runId: this.options.runId,
          principal: this.options.principal,
          grantId: grant.grantId,
          toolId,
          argumentsDigest,
          authorization,
        }))
      ) {
        return deny(
          "TOOL_REVISION_CONFLICT",
          "Commit requires a verified approval grant, expected revisions, and an idempotency key.",
        );
      }
    }

    const idempotencyKey = request.commitAuthorization?.idempotencyKey ?? null;
    if (idempotencyKey) {
      const prior = this.idempotencyResults.get(idempotencyKey);
      if (prior) {
        if (prior.argumentsDigest !== argumentsDigest) {
          return deny(
            "TOOL_REVISION_CONFLICT",
            "The idempotency key was already used with different arguments.",
          );
        }
        this.executionReceipts.push({ ...receiptBase, outcome: "replayed" });
        return {
          ok: true,
          value: {
            kind: "executed",
            toolId,
            result: structuredClone(prior.result),
            replayed: true,
          },
        };
      }
    }

    if (this.callsUsed >= this.options.budgets.maxToolCalls || grant.remainingCalls <= 0) {
      return deny("TOOL_BUDGET_EXCEEDED", "The run's tool-call budget is exhausted.");
    }

    this.callsUsed += 1;
    grant.remainingCalls -= 1;
    try {
      const result = await this.catalog.provider.invokeSelected({
        providerId: snapshot.providerId,
        toolId,
        arguments: structuredClone(request.arguments),
        schemaDigest: record.schemaDigest,
        idempotencyKey,
      });
      if (record.definition.outputSchema !== null) {
        const outputErrors = validateArguments(record.definition.outputSchema, result);
        if (outputErrors.length > 0) {
          throw new Error("Provider result did not match the selected tool's output schema.");
        }
      }
      if (idempotencyKey) {
        this.idempotencyResults.set(idempotencyKey, {
          argumentsDigest,
          result: structuredClone(result),
        });
      }
      this.executionReceipts.push({ ...receiptBase, outcome: "executed" });
      return {
        ok: true,
        value: { kind: "executed", toolId, result: structuredClone(result), replayed: false },
      };
    } catch {
      this.executionReceipts.push({ ...receiptBase, outcome: "failed" });
      return denial(toolId, "TOOL_UNAVAILABLE", "The selected provider tool failed.", true);
    }
  }
}
