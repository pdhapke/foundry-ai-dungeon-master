import type {
  AiDmActionProposal,
  AiDmContextRequest,
  AiDmContextView,
  AiDmJsonValue,
  AiDmLoadedToolDefinition,
  AiDmRun,
  AiDmToolEffect,
} from "@foundry-ai-dungeon-master/shared";

import type { ContextService } from "../context/index.js";
import type { AiDmBootstrapToolExecutor, AiDmToolExecutionResult } from "../runner/index.js";
import type { LoadedToolGrant, ToolCatalogRunSession } from "../tool-catalog/index.js";

export interface AiDmProposalCreator {
  create(input: {
    run: AiDmRun;
    callId: string;
    arguments: AiDmJsonValue;
  }): Promise<AiDmActionProposal>;
}

function object(value: AiDmJsonValue): Record<string, AiDmJsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  return value;
}

function strings(value: AiDmJsonValue | undefined, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value as string[];
}

function string(value: AiDmJsonValue | undefined, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function integer(value: AiDmJsonValue | undefined, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer.`);
  return value as number;
}

function json(value: unknown): AiDmJsonValue {
  return structuredClone(value) as AiDmJsonValue;
}

function contextRequest(
  runId: string,
  callId: string,
  name: string,
  value: AiDmJsonValue,
  view: AiDmContextView,
) {
  const args = object(value);
  const base = {
    requestId: `context:${callId}`,
    runId,
    operation: name as AiDmContextRequest["operation"],
    view,
    nodeIds: [] as string[],
  };
  switch (name) {
    case "context_get_root":
      return base;
    case "context_read":
      return { ...base, nodeIds: strings(args["nodeIds"], "nodeIds") };
    case "context_expand":
      return {
        ...base,
        nodeIds: strings(args["nodeIds"], "nodeIds"),
        relation: string(args["relation"], "relation"),
        maxDepth: integer(args["depth"], "depth"),
      };
    case "context_search":
      return { ...base, query: string(args["query"], "query") };
    case "context_get_changes":
      return { ...base, nodeIds: strings(args["refs"], "refs") };
    case "context_get_source":
      return {
        ...base,
        nodeIds: [string(args["sourceRef"], "sourceRef")],
        sourceSpan: {
          startLine: integer(args["startLine"], "startLine"),
          endLine: integer(args["endLine"], "endLine"),
        },
      };
    default:
      throw new Error(`Unknown context operation ${name}.`);
  }
}

function selectedEffect(loaded: LoadedToolGrant): AiDmToolEffect {
  if (loaded.definition.risk === "consequential" || loaded.definition.risk === "destructive") {
    return "propose";
  }
  const allowed = loaded.grant.allowedEffects;
  return allowed.includes("read")
    ? "read"
    : allowed.includes("simulate")
      ? "simulate"
      : allowed.includes("present")
        ? "present"
        : "propose";
}

/** Run-scoped adapter joining context discovery, trusted tool discovery, and proposals. */
export class AiDmRunBootstrapExecutor implements AiDmBootstrapToolExecutor {
  readonly #searchByTool = new Map<string, string>();
  readonly #loaded = new Map<string, LoadedToolGrant>();
  readonly searchResults: import("@foundry-ai-dungeon-master/shared").AiDmToolSearchResult[] = [];
  readonly loadedDefinitions: AiDmLoadedToolDefinition[] = [];

  constructor(
    private readonly context: ContextService,
    private readonly catalog: ToolCatalogRunSession,
    private readonly proposals: AiDmProposalCreator,
    private readonly contextView: AiDmContextView = "resolver",
  ) {}

  async execute(input: {
    run: AiDmRun;
    callId: string;
    name: string;
    arguments: AiDmJsonValue;
  }): Promise<AiDmToolExecutionResult> {
    if (input.name.startsWith("context_")) {
      return {
        output: json(
          this.context.execute(
            contextRequest(
              input.run.runId,
              input.callId,
              input.name,
              input.arguments,
              this.contextView,
            ),
          ),
        ),
      };
    }
    if (input.name === "tool_search") {
      const args = object(input.arguments);
      const result = this.catalog.search({
        query: string(args["query"], "query"),
        alreadyLoaded: strings(args["alreadyLoaded"], "alreadyLoaded"),
        limit: integer(args["limit"], "limit"),
      });
      if (result.ok) {
        this.searchResults.push(structuredClone(result.value));
        for (const descriptor of result.value.descriptors) {
          this.#searchByTool.set(descriptor.toolId, result.value.searchId);
        }
        return { output: json(result.value) };
      }
      return { output: json(result.denial) };
    }
    if (input.name === "tool_load") {
      const args = object(input.arguments);
      const definitions: AiDmLoadedToolDefinition[] = [];
      const denials: AiDmJsonValue[] = [];
      for (const toolId of strings(args["toolIds"], "toolIds")) {
        const searchId = this.#searchByTool.get(toolId);
        if (!searchId) {
          denials.push({ toolId, code: "TOOL_UNKNOWN", retryable: false });
          continue;
        }
        const loaded = this.catalog.load(searchId, toolId);
        if (!loaded.ok) {
          denials.push(json(loaded.denial));
          continue;
        }
        this.#loaded.set(toolId, loaded.value);
        definitions.push(loaded.value.definition);
        this.loadedDefinitions.push(structuredClone(loaded.value.definition));
      }
      return {
        output: { loadedToolIds: definitions.map(({ toolId }) => toolId), denials },
        loadedDefinitions: definitions,
      };
    }
    if (input.name === "state_propose") {
      const args = object(input.arguments);
      const operations = args["operations"];
      if (!Array.isArray(operations)) throw new Error("Proposal operations are required.");
      for (const value of operations) {
        const operation = object(value);
        const toolId = string(operation["toolId"], "toolId");
        if (!this.#loaded.has(toolId)) {
          throw new Error(`Proposal tool ${toolId} was not discovered and loaded for this run.`);
        }
      }
      const proposal = await this.proposals.create(input);
      return {
        output: {
          proposalId: proposal.proposalId,
          proposalRevision: proposal.proposalRevision,
          status: proposal.status,
        },
        proposal,
      };
    }

    const loaded = this.#loaded.get(input.name);
    if (!loaded) throw new Error(`Tool ${input.name} is not loaded for this run.`);
    const outcome = await this.catalog.executeGrant({
      grantId: loaded.grant.grantId,
      effect: selectedEffect(loaded),
      arguments: input.arguments,
    });
    return outcome.ok ? { output: json(outcome.value) } : { output: json(outcome.denial) };
  }
}
