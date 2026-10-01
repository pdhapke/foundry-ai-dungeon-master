import type {
  AiDmActionProposal,
  AiDmContextReceipt,
  AiDmJsonValue,
  AiDmLoadedToolDefinition,
  AiDmNormalizedEvent,
  AiDmRun,
  AiDmRuntimeProjection,
} from "@foundry-ai-dungeon-master/shared";

export interface AiDmBootstrapContext {
  event: AiDmNormalizedEvent;
  projection: AiDmRuntimeProjection;
  rootManifest: AiDmJsonValue;
  continuationCapsule: AiDmJsonValue | null;
}

export interface AiDmProviderTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict: boolean;
}

export type AiDmProviderErrorCode =
  | "PROVIDER_REQUEST_INVALID"
  | "PROVIDER_REQUEST_TOO_LARGE"
  | "PROVIDER_RECONNECT_REQUIRED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_RESPONSE_FAILED"
  | "PROVIDER_RESPONSE_INCOMPLETE"
  | "PROVIDER_STREAM_ERROR"
  | "PROVIDER_STREAM_MALFORMED"
  | "PROVIDER_STREAM_INTERRUPTED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ABORTED";

export interface AiDmProviderErrorOptions {
  code: AiDmProviderErrorCode;
  message: string;
  requestAccepted: boolean;
  retryable: boolean;
  httpStatus?: number;
  providerCode?: string;
  providerType?: string;
  providerParam?: string;
  requestId?: string;
  terminalEventType?: string;
  providerResponseId?: string;
}

/** A credential-free provider failure suitable for deterministic orchestration policy. */
export class AiDmProviderError extends Error {
  readonly code: AiDmProviderErrorCode;
  readonly requestAccepted: boolean;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly providerCode: string | undefined;
  readonly providerType: string | undefined;
  readonly providerParam: string | undefined;
  readonly requestId: string | undefined;
  readonly terminalEventType: string | undefined;
  readonly providerResponseId: string | undefined;

  constructor(options: AiDmProviderErrorOptions) {
    super(options.message);
    this.name = "AiDmProviderError";
    this.code = options.code;
    this.requestAccepted = options.requestAccepted;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.providerCode = options.providerCode;
    this.providerType = options.providerType;
    this.providerParam = options.providerParam;
    this.requestId = options.requestId;
    this.terminalEventType = options.terminalEventType;
    this.providerResponseId = options.providerResponseId;
  }
}

export interface AiDmProviderFunctionCall {
  type: "function_call";
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface AiDmProviderTextOutput {
  type: "text";
  text: string;
}

export type AiDmProviderOutput = AiDmProviderFunctionCall | AiDmProviderTextOutput;

export interface AiDmProviderRequest {
  runId: string;
  worldId: string;
  model: string;
  instructions: string;
  input: AiDmJsonValue;
  tools: AiDmProviderTool[];
  previousResponseId: string | null;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface AiDmProviderResponse {
  responseId: string;
  outputs: AiDmProviderOutput[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AiDmProvider {
  createResponse(request: AiDmProviderRequest): Promise<AiDmProviderResponse>;
  releaseRun?(runId: string): void;
}

export interface AiDmToolExecutionResult {
  output: AiDmJsonValue;
  loadedDefinitions?: AiDmLoadedToolDefinition[];
  proposal?: AiDmActionProposal;
}

export interface AiDmBootstrapToolExecutor {
  execute(input: {
    run: AiDmRun;
    callId: string;
    name: string;
    arguments: AiDmJsonValue;
  }): Promise<AiDmToolExecutionResult>;
}

export interface AiDmRunnerHooks {
  onStatus(status: AiDmRun["status"]): Promise<void> | void;
  onOutputDelta(delta: string): Promise<void> | void;
  onProviderResponse(responseId: string): Promise<void> | void;
}

export interface AiDmRunResult {
  finalText: string;
  contextReceipt: AiDmContextReceipt | null;
  proposalIds: string[];
  providerResponseIds: string[];
  usage: { inputTokens: number; outputTokens: number };
}
