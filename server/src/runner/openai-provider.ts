import OpenAI from "openai";
import type {
  NamespaceTool,
  Response,
  ResponseInputItem,
  Tool,
} from "openai/resources/responses/responses";

import {
  AiDmProviderError,
  type AiDmProvider,
  type AiDmProviderOutput,
  type AiDmProviderRequest,
  type AiDmProviderResponse,
} from "./types.js";

const CHATGPT_REQUEST_MAX_BYTES = 1024 * 1024;
const CHATGPT_TOOL_NAMESPACE = "foundry_ai_dm";
const SAFE_DETAIL = /^[A-Za-z0-9._:[\]-]{1,160}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function safeDetail(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_DETAIL.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStrictSchema(schema: unknown, path = "parameters"): void {
  if (!isRecord(schema)) {
    throw new AiDmProviderError({
      code: "PROVIDER_REQUEST_INVALID",
      message: `Provider tool ${path} must be an object schema.`,
      requestAccepted: false,
      retryable: false,
    });
  }
  if (path === "parameters" && schema["type"] !== "object") {
    throw new AiDmProviderError({
      code: "PROVIDER_REQUEST_INVALID",
      message: "Provider tool parameters must use an object schema.",
      requestAccepted: false,
      retryable: false,
    });
  }
  const allowed = new Set([
    "$defs",
    "$ref",
    "additionalProperties",
    "anyOf",
    "const",
    "description",
    "enum",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "format",
    "items",
    "maxItems",
    "maxLength",
    "maximum",
    "minItems",
    "minLength",
    "minimum",
    "multipleOf",
    "pattern",
    "properties",
    "required",
    "title",
    "type",
  ]);
  const unsupported = Object.keys(schema).find((key) => !allowed.has(key));
  if (unsupported) {
    throw new AiDmProviderError({
      code: "PROVIDER_REQUEST_INVALID",
      message: `Provider tool ${path} uses an unsupported strict-schema keyword.`,
      requestAccepted: false,
      retryable: false,
    });
  }
  const types = Array.isArray(schema["type"]) ? schema["type"] : [schema["type"]];
  if (types.includes("object")) {
    const properties = schema["properties"];
    const required = schema["required"];
    if (
      !isRecord(properties) ||
      !Array.isArray(required) ||
      required.some((entry) => typeof entry !== "string") ||
      schema["additionalProperties"] !== false
    ) {
      throw new AiDmProviderError({
        code: "PROVIDER_REQUEST_INVALID",
        message: `Provider tool ${path} is not compatible with strict object schemas.`,
        requestAccepted: false,
        retryable: false,
      });
    }
    const propertyNames = Object.keys(properties).sort();
    const requiredNames = [...new Set(required as string[])].sort();
    if (
      propertyNames.length !== requiredNames.length ||
      propertyNames.some((name, index) => name !== requiredNames[index])
    ) {
      throw new AiDmProviderError({
        code: "PROVIDER_REQUEST_INVALID",
        message: `Provider tool ${path} must require every strict object property.`,
        requestAccepted: false,
        retryable: false,
      });
    }
    for (const [name, child] of Object.entries(properties)) {
      validateStrictSchema(child, `${path}.properties.${name}`);
    }
  }
  if (schema["items"] !== undefined) validateStrictSchema(schema["items"], `${path}.items`);
  if (schema["anyOf"] !== undefined) {
    if (!Array.isArray(schema["anyOf"]) || schema["anyOf"].length === 0) {
      throw new AiDmProviderError({
        code: "PROVIDER_REQUEST_INVALID",
        message: `Provider tool ${path}.anyOf must contain schemas.`,
        requestAccepted: false,
        retryable: false,
      });
    }
    schema["anyOf"].forEach((child, index) =>
      validateStrictSchema(child, `${path}.anyOf[${index}]`),
    );
  }
  if (schema["$defs"] !== undefined) {
    if (!isRecord(schema["$defs"])) {
      throw new AiDmProviderError({
        code: "PROVIDER_REQUEST_INVALID",
        message: `Provider tool ${path} has invalid schema definitions.`,
        requestAccepted: false,
        retryable: false,
      });
    }
    for (const [name, child] of Object.entries(schema["$defs"])) {
      validateStrictSchema(child, `${path}.$defs.${name}`);
    }
  }
}

function namespaceTools(requestTools: readonly AiDmProviderRequest["tools"][number][]): Tool[] {
  if (requestTools.length === 0) return [];
  const names = new Set<string>();
  const tools: NamespaceTool.Function[] = requestTools.map((tool) => {
    if (!TOOL_NAME.test(tool.name) || names.has(tool.name)) {
      throw new AiDmProviderError({
        code: "PROVIDER_REQUEST_INVALID",
        message: "Provider tool names must be unique and use the supported function-name syntax.",
        requestAccepted: false,
        retryable: false,
      });
    }
    names.add(tool.name);
    if (tool.strict) validateStrictSchema(tool.inputSchema);
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: tool.strict,
    };
  });
  return [
    {
      type: "namespace",
      name: CHATGPT_TOOL_NAMESPACE,
      description:
        "Local Foundry AI Dungeon Master context, workflow, and authorized capability tools.",
      tools,
    },
  ];
}

function safeApiError(error: {
  status?: number;
  code?: unknown;
  type?: unknown;
  param?: unknown;
  requestID?: unknown;
}): AiDmProviderError {
  const status = error.status;
  const providerCode = safeDetail(error.code);
  const providerType = safeDetail(error.type);
  const providerParam = safeDetail(error.param);
  const requestId = safeDetail(error.requestID);
  const reconnectRequired = status === 401 || status === 403;
  const definitelyRejected =
    status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409;
  return new AiDmProviderError({
    code: reconnectRequired ? "PROVIDER_RECONNECT_REQUIRED" : "PROVIDER_HTTP_ERROR",
    message: reconnectRequired
      ? "ChatGPT authorization was rejected. Reconnect ChatGPT and select an eligible model."
      : status
        ? `The AI provider rejected the request with HTTP ${status}.`
        : "AI provider request failed.",
    requestAccepted: !definitelyRejected,
    retryable: false,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(providerCode ? { providerCode } : {}),
    ...(providerType ? { providerType } : {}),
    ...(providerParam ? { providerParam } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function hasSyntaxErrorCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof SyntaxError) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

export class OpenAiResponsesProvider implements AiDmProvider {
  readonly #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({ apiKey });
  }

  async createResponse(request: AiDmProviderRequest): Promise<AiDmProviderResponse> {
    const input = request.previousResponseId
      ? (request.input as unknown as ResponseInputItem[])
      : JSON.stringify(request.input);
    const tools: Tool[] = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: tool.strict,
    }));
    const response = await this.#client.responses.create(
      {
        model: request.model,
        instructions: request.instructions,
        input,
        tools,
        previous_response_id: request.previousResponseId,
        max_output_tokens: request.maxOutputTokens,
        store: true,
      },
      { signal: request.signal },
    );

    const outputs: AiDmProviderOutput[] = [];
    for (const item of response.output) {
      if (item.type === "function_call") {
        outputs.push({
          type: "function_call",
          callId: item.call_id,
          name: item.name,
          argumentsJson: item.arguments,
        });
      } else if (item.type === "message") {
        for (const content of item.content) {
          if (content.type === "output_text") outputs.push({ type: "text", text: content.text });
        }
      }
    }

    return {
      responseId: response.id,
      outputs,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }
}

/** Uses ChatGPT-plan OAuth under the token-sharing preview's stateless constraints. */
export class ChatGptPlanResponsesProvider implements AiDmProvider {
  readonly #authorization: (
    worldId: string,
    configuredModel: string,
  ) => Promise<{ accessToken: string; model: string; authorizationId?: string }>;
  readonly #history = new Map<string, ResponseInputItem[]>();
  readonly #fetch: typeof fetch;
  readonly #invalidateAuthorization:
    ((worldId: string, authorizationId?: string) => Promise<void>) | undefined;
  readonly #invokeConstructedRequest:
    | ((
        body: Parameters<OpenAI["responses"]["stream"]>[0],
        request: AiDmProviderRequest,
      ) => Promise<AiDmProviderResponse>)
    | undefined;

  constructor(
    authorization: (
      worldId: string,
      configuredModel: string,
    ) => Promise<{ accessToken: string; model: string; authorizationId?: string }>,
    invokeConstructedRequest?: (
      body: Parameters<OpenAI["responses"]["stream"]>[0],
      request: AiDmProviderRequest,
    ) => Promise<AiDmProviderResponse>,
    providerFetch: typeof fetch = globalThis.fetch,
    invalidateAuthorization?: (worldId: string, authorizationId?: string) => Promise<void>,
  ) {
    this.#authorization = authorization;
    this.#invokeConstructedRequest = invokeConstructedRequest;
    this.#fetch = providerFetch;
    this.#invalidateAuthorization = invalidateAuthorization;
  }

  async createResponse(request: AiDmProviderRequest): Promise<AiDmProviderResponse> {
    if (request.signal.aborted) {
      throw new AiDmProviderError({
        code: "PROVIDER_ABORTED",
        message: "The AI provider request was cancelled before dispatch.",
        requestAccepted: false,
        retryable: false,
      });
    }
    const prior = this.#history.get(request.runId) ?? [];
    const incoming: ResponseInputItem[] = request.previousResponseId
      ? (request.input as unknown as ResponseInputItem[]).map((item) => {
          if (item.type !== "function_call_output" || typeof item.output === "string") return item;
          return { ...item, output: JSON.stringify(item.output) };
        })
      : [{ role: "user", content: JSON.stringify(request.input) }];
    const candidate = [...prior, ...incoming];
    let authorization: { accessToken: string; model: string; authorizationId?: string };
    try {
      authorization = await this.#authorization(request.worldId, request.model);
    } catch (error) {
      if (error instanceof Error && error.name === "ChatGptReconnectRequiredError") {
        throw new AiDmProviderError({
          code: "PROVIDER_RECONNECT_REQUIRED",
          message:
            "ChatGPT authorization was rejected. Reconnect ChatGPT and select an eligible model.",
          requestAccepted: false,
          retryable: false,
        });
      }
      throw error;
    }
    if (request.signal.aborted) {
      throw new AiDmProviderError({
        code: "PROVIDER_ABORTED",
        message: "The AI provider request was cancelled before dispatch.",
        requestAccepted: false,
        retryable: false,
      });
    }
    let dispatched = false;
    let responseStarted = false;
    let responseRequestId: string | undefined;
    let providerResponseId: string | undefined;
    const client = new OpenAI({
      apiKey: authorization.accessToken,
      maxRetries: 0,
      logLevel: "off",
      fetch: async (input, init) => {
        dispatched = true;
        const response = await this.#fetch(input, init);
        responseStarted = response.ok;
        responseRequestId = safeDetail(response.headers.get("x-request-id"));
        // The SDK's streaming contract is defined by stream: true and the SSE body.
        // Some intermediaries rewrite or omit Content-Type, so validate terminal
        // events instead of cancelling a potentially valid stream by header alone.
        return response;
      },
    });
    const tools = namespaceTools(request.tools);
    const body = {
      model: authorization.model,
      instructions: request.instructions,
      input: candidate,
      tools,
      store: false,
    } satisfies Parameters<OpenAI["responses"]["stream"]>[0];
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > CHATGPT_REQUEST_MAX_BYTES) {
      throw new AiDmProviderError({
        code: "PROVIDER_REQUEST_TOO_LARGE",
        message: "The AI provider request exceeds the safe size limit.",
        requestAccepted: false,
        retryable: false,
      });
    }
    if (this.#invokeConstructedRequest) {
      return this.#invokeConstructedRequest(body, request);
    }
    let response: Response | null = null;
    try {
      const stream = client.responses.stream(body, { signal: request.signal });
      for await (const event of stream) {
        if ("response" in event && typeof event.response?.id === "string") {
          providerResponseId ??= event.response.id;
        }
        if (event.type === "response.completed") {
          if (response) {
            throw new AiDmProviderError({
              code: "PROVIDER_STREAM_MALFORMED",
              message: "The AI provider stream contained multiple terminal events.",
              requestAccepted: true,
              retryable: false,
              terminalEventType: event.type,
              ...(responseRequestId ? { requestId: responseRequestId } : {}),
              ...(providerResponseId ? { providerResponseId } : {}),
            });
          }
          response = event.response;
        } else if (event.type === "response.failed") {
          const providerCode = safeDetail(event.response.error?.code);
          throw new AiDmProviderError({
            code: "PROVIDER_RESPONSE_FAILED",
            message: "The AI provider reported a failed response.",
            requestAccepted: true,
            retryable: false,
            terminalEventType: event.type,
            ...(providerCode ? { providerCode } : {}),
            ...(responseRequestId ? { requestId: responseRequestId } : {}),
            ...(providerResponseId ? { providerResponseId } : {}),
          });
        } else if (event.type === "response.incomplete") {
          const providerCode = safeDetail(event.response.incomplete_details?.reason);
          throw new AiDmProviderError({
            code: "PROVIDER_RESPONSE_INCOMPLETE",
            message: "The AI provider reported an incomplete response.",
            requestAccepted: true,
            retryable: false,
            terminalEventType: event.type,
            ...(providerCode ? { providerCode } : {}),
            ...(responseRequestId ? { requestId: responseRequestId } : {}),
            ...(providerResponseId ? { providerResponseId } : {}),
          });
        } else if (event.type === "error") {
          const providerCode = safeDetail(event.code);
          const providerParam = safeDetail(event.param);
          throw new AiDmProviderError({
            code: "PROVIDER_STREAM_ERROR",
            message: "The AI provider emitted a stream error.",
            requestAccepted: true,
            retryable: false,
            terminalEventType: event.type,
            ...(providerCode ? { providerCode } : {}),
            ...(providerParam ? { providerParam } : {}),
            ...(responseRequestId ? { requestId: responseRequestId } : {}),
            ...(providerResponseId ? { providerResponseId } : {}),
          });
        } else if (response) {
          throw new AiDmProviderError({
            code: "PROVIDER_STREAM_MALFORMED",
            message: "The AI provider stream continued after completion.",
            requestAccepted: true,
            retryable: false,
            terminalEventType: event.type,
            ...(responseRequestId ? { requestId: responseRequestId } : {}),
            ...(providerResponseId ? { providerResponseId } : {}),
          });
        }
      }
    } catch (error) {
      if (error instanceof AiDmProviderError) throw error;
      if (request.signal.aborted) {
        const timedOut =
          request.signal.reason instanceof DOMException &&
          request.signal.reason.name === "TimeoutError";
        throw new AiDmProviderError({
          code: timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_ABORTED",
          message: timedOut
            ? "The AI provider request timed out."
            : "The AI provider request was cancelled.",
          requestAccepted: dispatched,
          retryable: false,
          ...(responseRequestId ? { requestId: responseRequestId } : {}),
          ...(providerResponseId ? { providerResponseId } : {}),
        });
      }
      if (error instanceof OpenAI.APIError && error.status !== undefined) {
        if ((error.status === 401 || error.status === 403) && this.#invalidateAuthorization) {
          await this.#invalidateAuthorization(request.worldId, authorization.authorizationId).catch(
            () => undefined,
          );
        }
        throw safeApiError(error);
      }
      if (hasSyntaxErrorCause(error)) {
        throw new AiDmProviderError({
          code: "PROVIDER_STREAM_MALFORMED",
          message: "The AI provider returned a malformed event stream.",
          requestAccepted: responseStarted,
          retryable: false,
          ...(responseRequestId ? { requestId: responseRequestId } : {}),
          ...(providerResponseId ? { providerResponseId } : {}),
        });
      }
      throw new AiDmProviderError({
        code: "PROVIDER_STREAM_ERROR",
        message: "The AI provider stream failed after dispatch.",
        requestAccepted: dispatched,
        retryable: false,
        ...(responseRequestId ? { requestId: responseRequestId } : {}),
        ...(providerResponseId ? { providerResponseId } : {}),
      });
    }
    if (!response) {
      throw new AiDmProviderError({
        code: "PROVIDER_STREAM_INTERRUPTED",
        message: "The AI provider stream ended without response.completed.",
        requestAccepted: responseStarted || dispatched,
        retryable: false,
        ...(responseRequestId ? { requestId: responseRequestId } : {}),
        ...(providerResponseId ? { providerResponseId } : {}),
      });
    }
    this.#history.set(request.runId, [
      ...candidate,
      ...(response.output as unknown as ResponseInputItem[]),
    ]);

    const outputs: AiDmProviderOutput[] = [];
    for (const item of response.output) {
      if (item.type === "function_call") {
        outputs.push({
          type: "function_call",
          callId: item.call_id,
          name: item.name,
          argumentsJson: item.arguments,
        });
      } else if (item.type === "message") {
        for (const content of item.content) {
          if (content.type === "output_text") outputs.push({ type: "text", text: content.text });
        }
      }
    }
    return {
      responseId: response.id,
      outputs,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  releaseRun(runId: string): void {
    this.#history.delete(runId);
  }
}

export class PreferredResponsesProvider implements AiDmProvider {
  constructor(
    readonly plan: AiDmProvider,
    readonly apiKeyFallback: AiDmProvider | null,
    readonly planState: (worldId: string) => "absent" | "eligible" | "blocked",
  ) {}

  createResponse(request: AiDmProviderRequest): Promise<AiDmProviderResponse> {
    const state = this.planState(request.worldId);
    if (state === "eligible") return this.plan.createResponse(request);
    if (state === "blocked") {
      return Promise.reject(
        new Error("The connected ChatGPT session is not authorized for model use."),
      );
    }
    if (this.apiKeyFallback) return this.apiKeyFallback.createResponse(request);
    return Promise.reject(new Error("The GM has not connected ChatGPT for this world."));
  }

  releaseRun(runId: string): void {
    this.plan.releaseRun?.(runId);
    this.apiKeyFallback?.releaseRun?.(runId);
  }
}
