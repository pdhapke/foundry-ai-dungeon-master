import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AiDmJsonValue, AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
import { TrustedToolCatalog } from "../tool-catalog/catalog.js";
import { ToolCatalogRunSession } from "../tool-catalog/runtime.js";
import { digestJson } from "../tool-catalog/canonical.js";
import { SESSION_SEMANTIC_TOOLS, sessionSemanticSchema } from "./session-actions.js";
import { REVIEWED_WORLD_TOOLS } from "./world-tool-policy.js";
import { WORLD_FILE_SEMANTIC_TOOLS } from "./world-file-actions.js";
import { PREPARATION_TOOL, preparationToolSchema } from "./preparation-contract.js";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/foundry-local-api-adapter.js";
import type {
  ProviderToolDefinition,
  ToolCatalogProvider,
  ToolMetadataOverlay,
} from "../tool-catalog/types.js";

const object = (value: AiDmJsonValue): Record<string, AiDmJsonValue> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed observation");
  return value;
};
const json = (value: unknown): AiDmJsonValue => value as AiDmJsonValue;
const reference = z.string().min(1).max(128);
const search = z
  .object({ query: z.string().trim().min(1).max(256), limit: z.number().int().min(1).max(8) })
  .strict();
const load = z.object({ searchId: reference, toolId: reference }).strict();
const execution = z
  .object({
    grantId: reference,
    effect: z.enum(["read", "present", "propose", "session"]),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
const reads = [
  "foundry_list_scenes",
  "foundry_get_scene",
  "foundry_get_actor",
  "foundry_get_world",
  "foundry_get_system",
  "foundry_list_combats",
  "foundry_get_game_paused",
];
const roll = "ai_dm_roll_dice";
const note = "ai_dm_propose_private_note";
const pause = "ai_dm_set_game_paused";
const metadata: ToolMetadataOverlay[] = [...reads, roll, note, pause].map((toolId) => ({
  toolId,
  displayName: toolId,
  purpose:
    toolId === roll || toolId === pause
      ? toolId === pause
        ? "Pause unpause resume game on explicit current GM request with verified durable receipt"
        : "Roll native dice once with durable receipt"
      : toolId === note
        ? "Propose a private GM session note for exact human review"
        : "Read bounded authorized current game state",
  useCases: [
    toolId === roll || toolId === pause
      ? toolId === pause
        ? "pause unpause resume game"
        : "dice roll action check"
      : toolId === note
        ? "private journal session note preparation"
        : "scene actor world rules combat",
  ],
  effects:
    toolId === pause
      ? ["session"]
      : toolId === roll
        ? ["present"]
        : toolId === note
          ? ["propose"]
          : ["read"],
  acceptsEntityTypes: [],
  producesEntityTypes: [],
  relatedToolIds: [],
  risk: toolId === pause ? "consequential" : "low",
  approvalPolicy: toolId === pause ? "gm-request" : toolId === note ? "gm-approval" : "none",
  requiredPermissions: ["current GM", "current world", "run capability"],
  discoverableBy: ["gm"],
  executableBy: ["gm"],
  idempotency:
    toolId === roll || toolId === pause || toolId === note ? "required" : "not-applicable",
  guarantees: { expectedRevision: false, idempotentCommit: false },
  keywords:
    toolId === roll || toolId === pause
      ? toolId === pause
        ? ["pause", "unpause", "resume", "game"]
        : ["dice", "roll", "check"]
      : toolId === note
        ? ["note", "journal", "session", "private"]
        : ["scene", "actor", "world", "rules", "combat"],
}));
metadata.push({ toolId: PREPARATION_TOOL, displayName: PREPARATION_TOOL,
  purpose: 'Prepare campaign records and private area map encounter jobs; guided setup interview and grounded retrieval, no generation or publication',
  useCases: ['campaign preparation setup interview RAG area travel map battlemap population readiness'],
  effects: ['read'], acceptsEntityTypes: [], producesEntityTypes: [], relatedToolIds: [],
  risk: 'low', approvalPolicy: 'none', requiredPermissions: ['current GM', 'current world', 'run capability'],
  discoverableBy: ['gm'], executableBy: ['gm'], idempotency: 'not-applicable',
  guarantees: { expectedRevision: false, idempotentCommit: false },
  keywords: ['preparation','campaign','setup','interview','retrieval','area','map','battlemap','forest','image','generation','population','readiness'],
});
const sessionRead = "ai_dm_get_session_action_state";
const tokenLightRead = "ai_dm_get_token_light";
metadata.push({ toolId: tokenLightRead, displayName: tokenLightRead,
  purpose: "Read emitted light and scene distance units on one placed token; not vision or ambient lights",
  useCases: ["token emitted light read emission radius color"], effects: ["read"],
  acceptsEntityTypes: [], producesEntityTypes: [], relatedToolIds: ["ai_dm_set_token_light"],
  risk: "low", approvalPolicy: "none", requiredPermissions: ["live GM", "current world"],
  discoverableBy: ["gm"], executableBy: ["gm"], idempotency: "not-applicable",
  guarantees: { expectedRevision: false, idempotentCommit: false }, keywords: ["token", "emitted", "light", "read"],
});
const sessionToolIds = [
  sessionRead,
  ...Object.keys(SESSION_SEMANTIC_TOOLS).filter((tool) => tool !== "ai_dm_move_token"),
];
const worldToolIds = new Map(
  [...REVIEWED_WORLD_TOOLS].map(([toolId, policy]) => [`ai_dm_world_${toolId.slice(8)}`, policy]),
);
for (const [toolId, policy] of worldToolIds) {
  const read = policy.operation === "get" || policy.operation === "list";
  metadata.push({
    toolId,
    displayName: toolId,
    purpose: `${policy.operation} ${policy.family.family} in the active world`,
    useCases: [
      `${policy.operation} ${policy.family.family} ${policy.family.documentType} world document`,
    ],
    effects: read ? ["read"] : policy.destructive ? ["propose"] : ["session"],
    acceptsEntityTypes: [],
    producesEntityTypes: [],
    relatedToolIds: [],
    risk: read ? "low" : policy.destructive ? "destructive" : "consequential",
    approvalPolicy: read ? "none" : policy.destructive ? "gm-approval" : "gm-request",
    requiredPermissions: ["current GM", "active world", "manual request for writes"],
    discoverableBy: ["gm"],
    executableBy: ["gm"],
    idempotency: read ? "not-applicable" : "required",
    guarantees: { expectedRevision: false, idempotentCommit: false },
    keywords: [
      policy.operation,
      policy.family.family,
      policy.family.documentType.toLowerCase(),
      "world",
      "document",
    ],
  });
}
const fileTools: Record<string, { operation: string; purpose: string }> = WORLD_FILE_SEMANTIC_TOOLS;
for (const [toolId, descriptor] of Object.entries(fileTools)) {
  const read = ["read", "list"].includes(descriptor.operation),
    proposal = ["delete", "recover"].includes(descriptor.operation);
  metadata.push({
    toolId,
    displayName: toolId,
    purpose: descriptor.purpose,
    useCases: [descriptor.purpose],
    effects: read ? ["read"] : proposal ? ["propose"] : ["session"],
    acceptsEntityTypes: [],
    producesEntityTypes: [],
    relatedToolIds: [],
    risk: read ? "low" : proposal ? "destructive" : "consequential",
    approvalPolicy: read ? "none" : proposal ? "gm-approval" : "gm-request",
    requiredPermissions: ["current GM", "active world", "manual request for writes"],
    discoverableBy: ["gm"],
    executableBy: ["gm"],
    idempotency: read ? "not-applicable" : "required",
    guarantees: { expectedRevision: false, idempotentCommit: false },
    keywords: [descriptor.operation, "world", "file", "folder", "directory"],
  });
}
function fileSchema(operation: string): AiDmJsonValue {
  const path = { type: "string", minLength: 1, maxLength: 500 };
  return {
    type: "object",
    additionalProperties: false,
    properties:
      operation === "list"
        ? {
            path,
            after: { type: "string", maxLength: 500 },
            limit: { type: "integer", minimum: 1, maximum: 20 },
          }
        : operation === "read"
          ? { path, encoding: { enum: ["utf8", "base64", "metadata"] } }
          : {
              actionId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
              path,
              expectedRevision: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
              encoding: { enum: ["utf8", "base64"] },
              content: { type: "string", maxLength: 24000 },
            },
    required:
      operation === "list"
        ? []
        : operation === "read"
          ? ["path"]
          : ["actionId", "path", "expectedRevision"],
  };
}
for (const toolId of sessionToolIds) {
  const descriptor = SESSION_SEMANTIC_TOOLS[toolId];
  metadata.push({
    toolId,
    displayName: toolId,
    purpose: descriptor?.purpose ?? "Read authoritative state before a routine session action",
    useCases: [
      descriptor?.purpose ??
        "HP door combat initiative condition music playlist chat preflight state",
    ],
    effects: descriptor ? ["session"] : ["read"],
    acceptsEntityTypes: [],
    producesEntityTypes: [],
    relatedToolIds: [sessionRead].filter((id) => id !== toolId),
    risk: descriptor ? "consequential" : "low",
    approvalPolicy: descriptor ? "gm-request" : "none",
    requiredPermissions: ["live GM", "active world", "explicit current user request"],
    discoverableBy: ["gm"],
    executableBy: ["gm"],
    idempotency: descriptor ? "required" : "not-applicable",
    guarantees: { expectedRevision: false, idempotentCommit: false },
    keywords: (
      descriptor?.purpose ?? "HP door combat initiative condition music playlist chat state"
    )
      .toLowerCase()
      .split(" "),
  });
}
const actionId = { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" };
const semanticSchema = (toolId: string): AiDmJsonValue => ({
  type: "object",
  additionalProperties: false,
  properties:
    toolId === pause
      ? { actionId, paused: { type: "boolean" }, expectedPaused: { type: "boolean" } }
      : toolId === roll
        ? {
            actionId,
            formula: {
              type: "string",
              pattern: "^([1-9]|[1-9][0-9])d(4|6|8|10|12|20|100)([+-][0-9]{1,3})?$",
            },
          }
        : {
            actionId,
            title: { type: "string", minLength: 1, maxLength: 120 },
            text: { type: "string", minLength: 1, maxLength: 4000 },
          },
  required:
    toolId === pause
      ? ["actionId", "paused", "expectedPaused"]
      : toolId === roll
        ? ["actionId", "formula"]
        : ["actionId", "title", "text"],
});

/** Reviewed semantic facade. Only this class can route a loaded grant to durable actions or projections. */
export class ChatKitCatalogTools {
  private readonly catalog: TrustedToolCatalog;
  private readonly session: ToolCatalogRunSession;
  private calls = 0;
  constructor(
    client: FoundryLocalApiMcpClient,
    principal: AiDmRunPrincipal,
    private readonly authorized: (signal: AbortSignal) => Promise<void>,
    private readonly adapter: (
      operation: string,
      args: AiDmJsonValue,
      signal: AbortSignal,
    ) => Promise<AiDmJsonValue>,
    private readonly nativeAvailable: boolean,
    private readonly filesAvailable = false,
    private readonly preparationAvailable = false,
  ) {
    const provider: ToolCatalogProvider = {
      snapshot: async () => {
        const live = await client.listTools();
        const definitions: ProviderToolDefinition[] = live
          .filter((tool) => tool.name !== roll && tool.name !== note && tool.name !== pause)
          .map((tool) => ({
            toolId: tool.name,
            description: reads.includes(tool.name)
              ? "Bounded authorized adapter projection; not raw GM document"
              : "Quarantined provider tool",
            inputSchema: tool.inputSchema,
            outputSchema: null,
            annotations: {
              upstreamSchemaDigest: digestJson({
                input: tool.inputSchema,
                output: tool.outputSchema ?? null,
              }),
            },
          }));
        if (preparationAvailable) definitions.push({ toolId: PREPARATION_TOOL,
            description: 'Deterministic preparation workflow. Budget 0: no inference/images/embeddings. For a NEW forest image use battlemap-generation-request with worldId=mcp-test, originating threadId, player-safe gridless prompt and new name. This records a secure manual ImageGen handoff: generation integration is unavailable, no image is generated and no spend is authorized. Only browser completion can import the matching privately staged PNG/receipt. Preserve generationId and threadId for subsequent prepare/status/review/apply/display; never substitute the old fixture or claim automatic generation. For the previously approved fixture use battlemap-prepare with worldId=mcp-test and explicit profile=gm-preview or tv, then report the exact native package for browser review/apply. GM preview never counts as physical acceptance. Import, completion, review, apply and display require authenticated human browser operations. No automatic activation or canonical publication. Fetch templates for other typed inputs.',
          inputSchema: preparationToolSchema, outputSchema: null, annotations: { trustedPreparationContract: 'v1' } });
        const dependencies: Record<string, string[]> = {
          [roll]: ["foundry_roll_dice"],
          [pause]: ["foundry_get_game_paused", "foundry_set_game_paused"],
          [note]: ["foundry_preflight_transaction", "foundry_execute_transaction"],
        };
        for (const toolId of [roll, note, pause]) {
          const required = dependencies[toolId]!;
          if (
            !nativeAvailable ||
            !required.every((name) => live.some((tool) => tool.name === name))
          )
            continue;
          const upstream = live
            .filter((tool) => required.includes(tool.name))
            .map((tool) => ({
              name: tool.name,
              input: tool.inputSchema,
              output: tool.outputSchema ?? null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          definitions.push({
            toolId,
            description:
              toolId === roll || toolId === pause
                ? toolId === pause
                  ? "Explicit GM pause setter with authoritative pre-read and verified post-read; no toggle"
                  : "Reviewed semantic native dice action; durable actionId, no chat posting"
                : "Reviewed semantic private-note proposal; pending requires authenticated human approval",
            inputSchema: semanticSchema(toolId),
            outputSchema: null,
            annotations: { upstreamSchemaDigest: digestJson(json(upstream)) },
          });
        }
        if (nativeAvailable && live.some(tool => tool.name === "foundry_get_token_light")) {
          definitions.push({ toolId: tokenLightRead, description: "Read one placed token emission and distance units",
            inputSchema: { type: "object", additionalProperties: false,
              properties: { sceneId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" }, tokenId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" } },
              required: ["sceneId", "tokenId"] }, outputSchema: null });
        }
        for (const toolId of sessionToolIds) {
          const required = ["foundry_get_session_action_state", "foundry_apply_session_action",
            ...(toolId === "ai_dm_set_token_light" ? ["foundry_set_token_light"] : [])];
          if (
            !nativeAvailable ||
            !required.every((name) => live.some((tool) => tool.name === name))
          )
            continue;
          definitions.push({
            toolId,
            description:
              SESSION_SEMANTIC_TOOLS[toolId]?.purpose ??
              "Bounded authorized routine preflight state",
            inputSchema: sessionSemanticSchema(toolId),
            outputSchema: null,
            annotations: {
              upstreamSchemaDigest: digestJson(
                json(live.filter((tool) => required.includes(tool.name))),
              ),
            },
          });
        }
        for (const [toolId, policy] of worldToolIds) {
          const original = live.find((tool) => tool.name === policy.toolId);
          const read = ["get", "list"].includes(policy.operation);
          const required = [
            "foundry_get_world_document",
            ...(!read ? ["foundry_apply_world_document"] : []),
          ];
          if (
            !nativeAvailable ||
            !original ||
            !required.every((name) => live.some((tool) => tool.name === name))
          )
            continue;
          definitions.push({
            toolId,
            description: policy.reason,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: read
                ? {
                    args: original.inputSchema,
                    ...(policy.operation === "list"
                      ? {
                          offset: { type: "integer", minimum: 0, maximum: 100000 },
                          limit: { type: "integer", minimum: 1, maximum: 20 },
                        }
                      : {}),
                  }
                : {
                    actionId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
                    args: original.inputSchema,
                    expectedRevision: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
                  },
              required: read ? ["args"] : ["actionId", "args", "expectedRevision"],
            },
            outputSchema: null,
            annotations: {
              upstreamSchemaDigest: digestJson(
                json([original, ...live.filter((tool) => required.includes(tool.name))]),
              ),
            },
          });
        }
        if (filesAvailable)
          for (const [toolId, descriptor] of Object.entries(fileTools))
            definitions.push({
              toolId,
              description: descriptor.purpose,
              inputSchema: fileSchema(descriptor.operation),
              outputSchema: null,
              annotations: { trustedWorldFilesContract: "v1" },
            });
        return {
          providerId: "chatkit-reviewed-facade",
          providerVersion: "1",
          revision: digestJson(json(definitions)),
          tools: definitions,
        };
      },
      invokeSelected: () => Promise.reject(new Error("Only scoped reviewed invocation is allowed")),
    };
    this.catalog = new TrustedToolCatalog(provider, metadata, "chatkit-discovery-v1");
    this.session = new ToolCatalogRunSession(this.catalog, {
      runId: `run:${randomUUID()}`,
      principal,
      budgets: { maxSearches: 4, maxLoadedDefinitions: 6, maxToolCalls: 12 },
    });
  }

  async execute(operation: string, args: unknown, signal: AbortSignal): Promise<AiDmJsonValue> {
    signal.throwIfAborted();
    await this.authorized(signal);
    if (++this.calls > 22 || Buffer.byteLength(JSON.stringify(args)) > 12000)
      throw new Error("Discovery budget exceeded");
    await this.catalog.refresh();
    signal.throwIfAborted();
    let result: AiDmJsonValue;
    if (operation === "tool_search") {
      const input = search.parse(args);
      result = json(this.session.search({ ...input, alreadyLoaded: [] }));
    } else if (operation === "tool_load") {
      const input = load.parse(args);
      result = json(this.session.load(input.searchId, input.toolId));
    } else if (operation === "tool_execute") {
      const input = execution.parse(args);
      result = json(
        await this.session.executeGrant(
          { ...input, arguments: json(input.arguments) },
          {
            signal,
            durableProposal: true,
            authorizeSession: async (invocation) => {
              signal.throwIfAborted();
              await this.authorized(signal);
              const tool = invocation.toolId;
              if (worldToolIds.has(tool))
                return (
                  object(
                    await this.adapter(
                      "native_world_authorize",
                      { ...object(invocation.arguments), toolId: worldToolIds.get(tool)!.toolId },
                      signal,
                    ),
                  )["authorized"] === true
                );
              if (fileTools[tool])
                return (
                  object(await this.adapter("world_file_authorize", invocation.arguments, signal))[
                    "authorized"
                  ] === true
                );
              if (tool !== pause && !sessionToolIds.includes(tool)) return false;
              const result = object(
                await this.adapter(
                  tool === pause ? "native_authorize_pause" : "native_session_authorize",
                  invocation.arguments,
                  signal,
                ),
              );
              return result["authorized"] === true;
            },
            authorizeProposal: async (invocation) => {
              signal.throwIfAborted();
              await this.authorized(signal);
              const policy = worldToolIds.get(invocation.toolId);
              if (policy?.destructive)
                return (
                  object(
                    await this.adapter(
                      "native_world_authorize",
                      { ...object(invocation.arguments), toolId: policy.toolId },
                      signal,
                    ),
                  )["authorized"] === true
                );
              const descriptor = fileTools[invocation.toolId];
              if (descriptor && ["delete", "recover"].includes(descriptor.operation))
                return (
                  object(await this.adapter("world_file_authorize", invocation.arguments, signal))[
                    "authorized"
                  ] === true
                );
              return false;
            },
            invoke: async (invocation) => {
              signal.throwIfAborted();
              await this.authorized(signal);
              const tool = invocation.toolId;
              const input = object(invocation.arguments);
              let output: AiDmJsonValue;
              if (tool === PREPARATION_TOOL) {
                output = await this.adapter('preparation_workflow', input, signal);
              } else if (worldToolIds.has(tool)) {
                const policy = worldToolIds.get(tool)!;
                output = await this.adapter(
                  ["get", "list"].includes(policy.operation)
                    ? "native_world_read"
                    : "native_world_write",
                  { ...input, toolId: policy.toolId },
                  signal,
                );
              } else if (fileTools[tool])
                output = await this.adapter(
                  `world_file_${fileTools[tool].operation}`,
                  input,
                  signal,
                );
              else if (tool === tokenLightRead)
                output = await this.adapter("native_token_light_read", input, signal);
              else if (tool === sessionRead)
                output = await this.adapter("native_session_read", input, signal);
              else if (sessionToolIds.includes(tool))
                output = await this.adapter("native_session_apply", input, signal);
              else if (tool === "foundry_get_game_paused")
                output = await this.adapter("native_get_pause", {}, signal);
              else if (tool === roll || tool === note || tool === pause)
                output = await this.adapter(
                  tool === pause
                    ? "native_set_pause"
                    : tool === roll
                      ? "native_roll"
                      : "native_propose_note",
                  input,
                  signal,
                );
              else if (tool === "foundry_get_actor")
                output = {
                  observation: await this.adapter("actor", input, signal),
                  narrationAllowed: false,
                  trust: "untrusted-source-data",
                };
              else if (tool === "foundry_get_scene" || tool === "foundry_list_scenes") {
                const scene = object(await this.adapter("scene", {}, signal));
                const details = scene["scene"] ? object(scene["scene"]) : null;
                if (tool === "foundry_get_scene" && input["id"] !== details?.["id"])
                  throw new Error("Only current scene is permitted");
                const tokens = Array.isArray(scene["tokens"])
                  ? scene["tokens"].filter((token) => object(token)["hidden"] !== true)
                  : [];
                output = {
                  scene: details,
                  tokens,
                  trust: "untrusted-source-data",
                  narrationAllowed: false,
                };
              } else if (
                ["foundry_get_world", "foundry_get_system", "foundry_list_combats"].includes(tool)
              ) {
                const context = object(await this.adapter("context", {}, signal));
                output = {
                  observation:
                    context[
                      tool === "foundry_get_world"
                        ? "world"
                        : tool === "foundry_get_system"
                          ? "rulesSystem"
                          : "combat"
                    ] ?? null,
                  trust: "untrusted-source-data",
                  narrationAllowed: false,
                };
              } else throw new Error("Unreviewed execution denied");
              await this.authorized(signal);
              signal.throwIfAborted();
              return output;
            },
          },
        ),
      );
    } else throw new Error("Unsupported catalog operation");
    await this.authorized(signal);
    signal.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(result)) > 24000)
      return {
        ok: false,
        denial: {
          code: "TOOL_BUDGET_EXCEEDED",
          message:
            "Selected definition/result exceeds bounded transport; unavailable, never truncated schema",
          retryable: false,
        },
      };
    return result;
  }
}
