import {
  parseBoundedAiDmJson,
  type AiDmJsonValue,
  type AiDmLoadedToolDefinition,
  type AiDmRun,
} from "@foundry-ai-dungeon-master/shared";
import { z } from "zod";

import { AI_DM_BOOTSTRAP_TOOLS, AI_DM_BOOTSTRAP_TOOL_NAMES } from "./bootstrap-tools.js";
import { AI_DM_STABLE_INSTRUCTIONS } from "./instructions.js";
import type {
  AiDmBootstrapContext,
  AiDmBootstrapToolExecutor,
  AiDmProvider,
  AiDmProviderTool,
  AiDmRunResult,
  AiDmRunnerHooks,
  AiDmProviderRequest,
  AiDmProviderResponse,
} from "./types.js";
import { AiDmProviderError } from "./types.js";

const completionSchema = z
  .object({
    finalText: z.string().min(1).max(40_000),
    contextReceiptId: z.string().min(1).max(160).nullable(),
    proposalIds: z.array(z.string().min(1).max(160)).max(12),
  })
  .strict();

export class AiDmRunnerError extends Error {
  constructor(
    readonly code:
      | "RUN_BUDGET_EXCEEDED"
      | "RUN_CANCELLED"
      | "PROVIDER_MALFORMED_OUTPUT"
      | "TOOL_NOT_LOADED"
      | "RUN_INCOMPLETE",
    message: string,
  ) {
    super(message);
    this.name = "AiDmRunnerError";
  }
}

export interface AiDmRunnerOptions {
  provider: AiDmProvider;
  toolExecutor: AiDmBootstrapToolExecutor;
  model: string;
  hooks?: Partial<AiDmRunnerHooks>;
}

function dynamicTool(definition: AiDmLoadedToolDefinition): AiDmProviderTool {
  if (
    typeof definition.inputSchema !== "object" ||
    definition.inputSchema === null ||
    Array.isArray(definition.inputSchema)
  ) {
    throw new AiDmRunnerError("PROVIDER_MALFORMED_OUTPUT", "Loaded tool schema is not an object.");
  }
  return {
    name: definition.toolId,
    description: `Trusted dynamically loaded capability ${definition.toolId}.`,
    inputSchema: definition.inputSchema,
    strict: true,
  };
}

function initialInput(context: AiDmBootstrapContext): AiDmJsonValue {
  return {
    event: context.event as unknown as AiDmJsonValue,
    root: context.rootManifest,
    projection: context.projection as unknown as AiDmJsonValue,
    continuationCapsule: context.continuationCapsule,
  };
}

export class AiDungeonMasterRunner {
  readonly #provider: AiDmProvider;
  readonly #toolExecutor: AiDmBootstrapToolExecutor;
  readonly #model: string;
  readonly #hooks: Partial<AiDmRunnerHooks>;

  constructor(options: AiDmRunnerOptions) {
    this.#provider = options.provider;
    this.#toolExecutor = options.toolExecutor;
    this.#model = options.model;
    this.#hooks = options.hooks ?? {};
  }

  async #createResponse(
    request: AiDmProviderRequest,
    maximumAttempts: number,
  ): Promise<AiDmProviderResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (request.signal.aborted) {
        throw new AiDmRunnerError("RUN_CANCELLED", "Run cancellation requested.");
      }
      try {
        return await this.#provider.createResponse(request);
      } catch (error) {
        if (error instanceof AiDmProviderError && error.providerResponseId) {
          await this.#hooks.onProviderResponse?.(error.providerResponseId);
        }
        lastError = error;
        const retryableBeforeAcceptance =
          error instanceof AiDmProviderError && !error.requestAccepted && error.retryable;
        if (!retryableBeforeAcceptance || attempt === maximumAttempts) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("AI provider request failed.");
  }

  async run(
    run: AiDmRun,
    context: AiDmBootstrapContext,
    signal: AbortSignal,
  ): Promise<AiDmRunResult> {
    if (run.providerResponseId !== null || run.providerResponseRunBinding !== null) {
      throw new AiDmRunnerError(
        "PROVIDER_MALFORMED_OUTPUT",
        "A fresh run cannot begin with a provider continuation.",
      );
    }

    const startedAt = Date.now();
    const loaded = new Map<string, AiDmLoadedToolDefinition>();
    const proposals = new Set<string>();
    const responseIds: string[] = [];
    let previousResponseId: string | null = null;
    let nextInput = initialInput(context);
    let calls = 0;
    let responseSteps = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let generatedOutputCharacters = 0;

    await this.#hooks.onStatus?.("resolving");

    try {
      while (responseSteps <= run.budgets.maxToolCalls + 1) {
        if (signal.aborted)
          throw new AiDmRunnerError("RUN_CANCELLED", "Run cancellation requested.");
        if (Date.now() - startedAt > run.budgets.maxWallClockMs) {
          throw new AiDmRunnerError("RUN_BUDGET_EXCEEDED", "Run wall-clock budget exceeded.");
        }
        responseSteps += 1;

        const tools = [
          ...AI_DM_BOOTSTRAP_TOOLS,
          ...[...loaded.values()].map((definition) => dynamicTool(definition)),
        ];
        const remainingMs = Math.max(1, run.budgets.maxWallClockMs - (Date.now() - startedAt));
        let response;
        try {
          response = await this.#createResponse(
            {
              runId: run.runId,
              worldId: run.principal.worldId,
              model: this.#model,
              instructions: AI_DM_STABLE_INSTRUCTIONS,
              input: nextInput,
              tools,
              previousResponseId,
              maxOutputTokens: Math.max(1, Math.ceil(run.budgets.maxOutputCharacters / 4)),
              signal: AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]),
            },
            run.budgets.maxProviderAttempts,
          );
        } catch (error) {
          if (signal.aborted) {
            throw new AiDmRunnerError("RUN_CANCELLED", "Run cancellation requested.");
          }
          if (Date.now() - startedAt >= run.budgets.maxWallClockMs) {
            throw new AiDmRunnerError("RUN_BUDGET_EXCEEDED", "Run wall-clock budget exceeded.");
          }
          throw error;
        }

        previousResponseId = response.responseId;
        responseIds.push(response.responseId);
        inputTokens += response.usage.inputTokens;
        outputTokens += response.usage.outputTokens;
        await this.#hooks.onProviderResponse?.(response.responseId);

        const functionCalls = response.outputs.filter((item) => item.type === "function_call");
        const text = response.outputs
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
        generatedOutputCharacters += text.length;
        if (generatedOutputCharacters > run.budgets.maxOutputCharacters) {
          throw new AiDmRunnerError("RUN_BUDGET_EXCEEDED", "Output character budget exceeded.");
        }

        if (functionCalls.length === 0) {
          throw new AiDmRunnerError("RUN_INCOMPLETE", "Provider returned without run_complete.");
        }

        const outputs: AiDmJsonValue[] = [];
        for (const call of functionCalls) {
          calls += 1;
          if (calls > run.budgets.maxToolCalls) {
            throw new AiDmRunnerError("RUN_BUDGET_EXCEEDED", "Tool-call budget exceeded.");
          }
          if (call.name === "run_complete") {
            const completion = completionSchema.parse(JSON.parse(call.argumentsJson));
            generatedOutputCharacters += completion.finalText.length;
            if (generatedOutputCharacters > run.budgets.maxOutputCharacters) {
              throw new AiDmRunnerError("RUN_BUDGET_EXCEEDED", "Output character budget exceeded.");
            }
            await this.#hooks.onOutputDelta?.(completion.finalText);
            return {
              finalText: completion.finalText,
              contextReceipt: null,
              proposalIds: [...new Set([...proposals, ...completion.proposalIds])],
              providerResponseIds: responseIds,
              usage: { inputTokens, outputTokens },
            };
          }
          if (!AI_DM_BOOTSTRAP_TOOL_NAMES.has(call.name) && !loaded.has(call.name)) {
            throw new AiDmRunnerError(
              "TOOL_NOT_LOADED",
              `Tool ${call.name} was not loaded for this run.`,
            );
          }

          const parsedArguments = parseBoundedAiDmJson(
            JSON.parse(call.argumentsJson),
          ) as AiDmJsonValue;
          await this.#hooks.onStatus?.(
            call.name.startsWith("context_")
              ? "reading-context"
              : call.name === "tool_search" || call.name === "tool_load"
                ? "searching-tools"
                : "resolving",
          );
          const result = await this.#toolExecutor.execute({
            run,
            callId: call.callId,
            name: call.name,
            arguments: parsedArguments,
          });
          for (const definition of result.loadedDefinitions ?? []) {
            if (loaded.size >= run.budgets.maxLoadedDefinitions && !loaded.has(definition.toolId)) {
              throw new AiDmRunnerError(
                "RUN_BUDGET_EXCEEDED",
                "Loaded-definition budget exceeded.",
              );
            }
            loaded.set(definition.toolId, definition);
          }
          if (result.proposal) proposals.add(result.proposal.proposalId);
          outputs.push({
            type: "function_call_output",
            call_id: call.callId,
            output: result.output,
          });
        }
        nextInput = outputs;
      }

      throw new AiDmRunnerError("RUN_BUDGET_EXCEEDED", "Provider continuation budget exceeded.");
    } finally {
      this.#provider.releaseRun?.(run.runId);
    }
  }
}
