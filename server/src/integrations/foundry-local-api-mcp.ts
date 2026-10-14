import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";

import type { FoundryLocalApiMcpClient, FoundryLocalApiMcpTool } from "../tool-catalog/index.js";
import { currentTraceId, latencySpan, latencyEvent } from "../latency-trace.js";
import { preparationErrorCode } from '../preparation/outcome.js';

export interface FoundryLocalApiMcpOptions {
  baseUrl: string;
  apiKey: string;
  clientVersion: string;
}

function json(value: unknown): AiDmJsonValue {
  return structuredClone(value) as AiDmJsonValue;
}

/** Only typed transport codes cross this boundary; private error prose never does. */
export function selectedCapabilityError(structured: unknown): Error {
  const value = structured && typeof structured === "object" ? structured as Record<string, unknown> : {};
  const error = value["error"] && typeof value["error"] === "object" ? value["error"] as Record<string, unknown> : {};
  const code = typeof error["code"] === "string" && ["NOT_CONNECTED", "TIMEOUT", "PERMISSION_DENIED", "INVALID_PAYLOAD", "UNSUPPORTED"].includes(error["code"]) ? error["code"] : "CAPABILITY_UNAVAILABLE";
  return Object.assign(new Error("The selected Foundry capability returned an error."), { code, retryable: error["retryable"] === true });
}

/** Server-only authenticated MCP connection; credentials never cross the browser bridge. */
export class StreamableFoundryLocalApiMcpClient implements FoundryLocalApiMcpClient {
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;

  constructor(private readonly options: FoundryLocalApiMcpOptions) {}

  async listTools(): Promise<readonly FoundryLocalApiMcpTool[]> {
    const result = await latencySpan("mcp:catalog-list", async () => (await this.#connected()).listTools());
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: json(tool.inputSchema),
      ...(tool.outputSchema ? { outputSchema: json(tool.outputSchema) } : {}),
      ...(tool.annotations
        ? { annotations: json(tool.annotations) as Record<string, AiDmJsonValue> }
        : {}),
    }));
  }

  async callTool(
    request: {
      name: string;
      arguments: AiDmJsonValue;
      idempotencyKey: string | null;
    },
    options?: RequestOptions,
  ): Promise<AiDmJsonValue> {
    if (
      typeof request.arguments !== "object" ||
      request.arguments === null ||
      Array.isArray(request.arguments)
    ) {
      throw new Error("MCP tool arguments must be an object.");
    }
    try {
      const result = await latencySpan("mcp:tool-roundtrip", async () => (
        await this.#connected()
      ).callTool(
        {
          name: request.name,
          arguments: request.arguments as Record<string, AiDmJsonValue>,
          _meta: { ...(request.idempotencyKey ? { "foundry-ai-dungeon-master/idempotency-key": request.idempotencyKey } : {}),
            ...(currentTraceId() ? { "foundry-ai-dungeon-master/trace-id": currentTraceId() } : {}) },
        },
        undefined,
        options,
      ));
      if (result.isError) throw selectedCapabilityError(result.structuredContent);
      if (result.structuredContent !== undefined) return json(result.structuredContent);
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter(
          (item): item is { type: "text"; text: string } =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string",
        )
        .map((item) => item.text)
        .join("\n");
      if (!text) return null;
      try {
        return json(JSON.parse(text));
      } catch {
        return text;
      }
    } catch(error) {
      const tool=['foundry_get_world','foundry_get_user_by_id','foundry_get_user_status'].includes(request.name)?request.name:'tool';
      latencyEvent(`mcp:${tool}:error:${preparationErrorCode(error).toLowerCase()}`,undefined,'error');
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#connecting = null;
    await client?.close();
  }

  async #connected(): Promise<Client> {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect();
    try {
      this.#client = await this.#connecting;
      return this.#client;
    } finally {
      this.#connecting = null;
    }
  }

  async #connect(): Promise<Client> {
    const client = new Client(
      { name: "foundry-ai-dungeon-master", version: this.options.clientVersion },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${this.options.baseUrl.replace(/\/$/, "")}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${this.options.apiKey}` } } },
    );
    try {
      await client.connect(transport as unknown as Transport);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}
