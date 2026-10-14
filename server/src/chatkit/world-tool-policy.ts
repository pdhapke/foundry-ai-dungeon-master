/** Source-reviewed document families. Matching names alone never admits a provider outside this table. */
export interface WorldDocumentFamily {
  family: string;
  singular: string;
  plural: string;
  documentType: string;
  idKey: string;
  parentKey?: string;
  parentFamily?: string;
  collectionKey?: string;
  echoSensitive?: boolean;
}
export const WORLD_DOCUMENT_FAMILIES: readonly WorldDocumentFamily[] = [
  { family: "actors", singular: "actor", plural: "actors", documentType: "Actor", idKey: "id" },
  { family: "items", singular: "item", plural: "items", documentType: "Item", idKey: "id" },
  {
    family: "journals",
    singular: "journal_entry",
    plural: "journal_entries",
    documentType: "JournalEntry",
    idKey: "id",
  },
  {
    family: "scenes",
    singular: "scene",
    plural: "scenes",
    documentType: "Scene",
    idKey: "id",
    echoSensitive: true,
  },
  {
    family: "combats",
    singular: "combat",
    plural: "combats",
    documentType: "Combat",
    idKey: "id",
    echoSensitive: true,
  },
  {
    family: "playlists",
    singular: "playlist",
    plural: "playlists",
    documentType: "Playlist",
    idKey: "id",
  },
  {
    family: "tables",
    singular: "roll_table",
    plural: "roll_tables",
    documentType: "RollTable",
    idKey: "id",
  },
  {
    family: "cards",
    singular: "cards_stack",
    plural: "cards_stacks",
    documentType: "Cards",
    idKey: "id",
  },
  { family: "folders", singular: "folder", plural: "folders", documentType: "Folder", idKey: "id" },
  {
    family: "journal-pages",
    singular: "journal_entry_page",
    plural: "journal_entry_pages",
    documentType: "JournalEntryPage",
    idKey: "pageId",
    parentKey: "journalEntryId",
    parentFamily: "journals",
    collectionKey: "pages",
  },
  {
    family: "actor-items",
    singular: "actor_item",
    plural: "actor_items",
    documentType: "Item",
    idKey: "itemId",
    parentKey: "actorId",
    parentFamily: "actors",
    collectionKey: "items",
  },
  {
    family: "actor-effects",
    singular: "actor_effect",
    plural: "actor_effects",
    documentType: "ActiveEffect",
    idKey: "effectId",
    parentKey: "parentId",
    parentFamily: "actors",
    collectionKey: "effects",
  },
  {
    family: "item-effects",
    singular: "item_effect",
    plural: "item_effects",
    documentType: "ActiveEffect",
    idKey: "effectId",
    parentKey: "parentId",
    parentFamily: "items",
    collectionKey: "effects",
  },
  ...[
    ["tokens", "token", "Token"],
    ["walls", "wall", "Wall"],
    ["drawings", "drawing", "Drawing"],
    ["notes", "note", "Note"],
    ["lights", "light", "AmbientLight"],
    ["sounds", "sound", "AmbientSound"],
    ["templates", "template", "MeasuredTemplate"],
    ["regions", "region", "Region"],
  ].map(([plural, singular, documentType]) => ({
    family: `scene-${plural}`,
    singular: `scene_${singular}`,
    plural: `scene_${plural}`,
    documentType: documentType!,
    idKey: singular === "token" ? "tokenId" : "placeableId",
    parentKey: "sceneId",
    parentFamily: "scenes",
    collectionKey: plural!,
    echoSensitive: ["tokens", "walls", "regions"].includes(plural!),
  })),
];
export type WorldOperation = "list" | "get" | "create" | "update" | "delete";
export interface WorldToolPolicy {
  toolId: string;
  family: WorldDocumentFamily;
  operation: WorldOperation;
  readBackTool: string;
  destructive: boolean;
  reason: string;
}
export const REVIEWED_WORLD_TOOLS: ReadonlyMap<string, WorldToolPolicy> = new Map(
  WORLD_DOCUMENT_FAMILIES.flatMap((family) =>
    (["list", "get", "create", "update", "delete"] as const).map((operation) => {
      const toolId = `foundry_${operation}_${operation === "list" ? family.plural : family.singular}`;
      return [
        toolId,
        {
          toolId,
          family,
          operation,
          readBackTool: `foundry_get_${family.singular}`,
          destructive: operation === "delete",
          reason:
            operation === "delete"
              ? "Exact authenticated human review plus verified absence required"
              : operation === "list" || operation === "get"
                ? "Bounded GM world read; untrusted and never implicitly narratable"
                : "Typed world document operation with durable claim, before hash and authoritative read-back",
        },
      ] as const;
    }),
  ),
);
/** Every actual descriptor receives a disposition; unknown/admin names are never auto-authorized by annotations. */
export function worldToolDisposition(toolId: string): { disposition: string; reason: string } {
  const policy = REVIEWED_WORLD_TOOLS.get(toolId);
  if (policy)
    return {
      disposition:
        policy.operation === "get" || policy.operation === "list"
          ? "reviewed-world-read"
          : policy.destructive
            ? "exact-review-required"
            : policy.family.echoSensitive
              ? "origin-bridge-required"
              : "reviewed-world-write",
      reason: policy.reason,
    };
  if (/macro|execute_script|evaluate|javascript/.test(toolId))
    return {
      disposition: "separate-code-review",
      reason: `${toolId}: executable code requires specific authenticated code review and a restricted executor`,
    };
  if (
    /identity|enroll|credential|api_key|module|setting|world|user|file|asset|reload|restart/.test(
      toolId,
    )
  )
    return {
      disposition: "separate-administration",
      reason: `${toolId}: host/security/world-administration scope requires a distinct supported control`,
    };
  return {
    disposition: "reviewed-specialized-adapter-required",
    reason: `${toolId}: outside typed document CRUD families; needs exact method-specific world scope, state and read-back policy`,
  };
}
export function sensitiveDocumentChange(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(sensitiveDocumentChange);
  return Object.entries(value).some(
    ([key, child]) =>
      /(?:^|[.])(?:ownership|permission|items|effects|pages|tokens|walls|regions|behaviors|command|script|macro|onUpdateTarget|onUpdateSource|onUseMacroName)(?:[.]|$)/i.test(
        key,
      ) || sensitiveDocumentChange(child),
  );
}
