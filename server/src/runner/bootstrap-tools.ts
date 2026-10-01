import type { AiDmProviderTool } from "./types.js";

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const AI_DM_BOOTSTRAP_TOOLS: readonly AiDmProviderTool[] = [
  {
    name: "context_get_root",
    description: "Read the deterministic root context manifest for this run.",
    strict: true,
    inputSchema: objectSchema({}, []),
  },
  {
    name: "context_read",
    description: "Read specific permitted context nodes by opaque node ID.",
    strict: true,
    inputSchema: objectSchema(
      { nodeIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 } },
      ["nodeIds"],
    ),
  },
  {
    name: "context_expand",
    description: "Traverse permitted relationships from context nodes within the run budget.",
    strict: true,
    inputSchema: objectSchema(
      {
        nodeIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
        relation: { type: "string", minLength: 1, maxLength: 80 },
        depth: { type: "integer", minimum: 1, maximum: 4 },
      },
      ["nodeIds", "relation", "depth"],
    ),
  },
  {
    name: "context_search",
    description: "Search only context visible to the current resolver or presenter view.",
    strict: true,
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 16 },
      },
      ["query", "limit"],
    ),
  },
  {
    name: "context_get_changes",
    description: "Read revision changes for already-known permitted context node references.",
    strict: true,
    inputSchema: objectSchema(
      {
        refs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
      },
      ["refs"],
    ),
  },
  {
    name: "context_get_source",
    description: "Read a bounded permitted excerpt through an opaque provenance handle.",
    strict: true,
    inputSchema: objectSchema(
      {
        sourceRef: { type: "string", minLength: 1, maxLength: 200 },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      ["sourceRef", "startLine", "endLine"],
    ),
  },
  {
    name: "tool_search",
    description: "Search trusted available operational capabilities by desired outcome.",
    strict: true,
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 1_000 },
        alreadyLoaded: { type: "array", items: { type: "string" }, maxItems: 32 },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
      ["query", "alreadyLoaded", "limit"],
    ),
  },
  {
    name: "tool_load",
    description: "Load full schemas for explicitly selected trusted tool descriptors.",
    strict: true,
    inputSchema: objectSchema(
      { toolIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 12 } },
      ["toolIds"],
    ),
  },
  {
    name: "state_propose",
    description: "Submit a typed non-committing proposal for consequential state changes.",
    // Proposal arguments intentionally contain the schema of a dynamically loaded tool.
    // They cannot be represented as a closed strict schema without changing their meaning,
    // so keep this one locally validated function explicitly non-strict.
    strict: false,
    inputSchema: objectSchema(
      {
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        operations: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 12 },
      },
      ["summary", "operations"],
    ),
  },
  {
    name: "run_complete",
    description:
      "Complete the run with recipient-safe output after all required context and proposal work.",
    strict: true,
    inputSchema: objectSchema(
      {
        finalText: { type: "string", minLength: 1, maxLength: 40_000 },
        contextReceiptId: { type: ["string", "null"] },
        proposalIds: { type: "array", items: { type: "string" }, maxItems: 12 },
      },
      ["finalText", "contextReceiptId", "proposalIds"],
    ),
  },
];

export const AI_DM_BOOTSTRAP_TOOL_NAMES = new Set(AI_DM_BOOTSTRAP_TOOLS.map(({ name }) => name));
