import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";

import { digestJson } from "./canonical.js";
import type {
  ProviderInvocation,
  ProviderToolDefinition,
  ProviderToolSnapshot,
  ToolCatalogProvider,
} from "./types.js";

export interface FoundryLocalApiMcpTool {
  name: string;
  description?: string;
  inputSchema: AiDmJsonValue;
  outputSchema?: AiDmJsonValue;
  annotations?: Readonly<Record<string, AiDmJsonValue>>;
}

/**
 * Transport-neutral slice of an authenticated MCP client. A later server
 * integration may back this with Streamable HTTP, but the catalog itself
 * neither opens sockets nor receives credentials.
 */
export interface FoundryLocalApiMcpClient {
  listTools(): Promise<readonly FoundryLocalApiMcpTool[]>;
  callTool(request: {
    name: string;
    arguments: AiDmJsonValue;
    idempotencyKey: string | null;
  }): Promise<AiDmJsonValue>;
}

export interface FoundryLocalApiProviderOptions {
  providerVersion: string;
  client: FoundryLocalApiMcpClient;
}

function definition(tool: FoundryLocalApiMcpTool): ProviderToolDefinition {
  return {
    toolId: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

/** Maps only the live tools/list snapshot and exact selected calls. */
export class FoundryLocalApiProviderAdapter implements ToolCatalogProvider {
  readonly providerId = "foundry-local-api";

  constructor(private readonly options: FoundryLocalApiProviderOptions) {}

  async snapshot(): Promise<ProviderToolSnapshot> {
    const tools = (await this.options.client.listTools())
      .map(definition)
      .sort((left, right) => left.toolId.localeCompare(right.toolId));
    return {
      providerId: this.providerId,
      providerVersion: this.options.providerVersion,
      revision: digestJson({
        providerId: this.providerId,
        providerVersion: this.options.providerVersion,
        tools,
      }),
      tools,
    };
  }

  invokeSelected(invocation: ProviderInvocation): Promise<AiDmJsonValue> {
    if (invocation.providerId !== this.providerId) {
      return Promise.reject(new Error("Provider identity mismatch."));
    }
    return this.options.client.callTool({
      name: invocation.toolId,
      arguments: invocation.arguments,
      idempotencyKey: invocation.idempotencyKey,
    });
  }
}
