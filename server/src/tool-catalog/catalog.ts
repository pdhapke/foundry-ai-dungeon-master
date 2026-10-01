import type {
  AiDmJsonValue,
  AiDmRunPrincipal,
  AiDmToolDiscoveryDescriptor,
  AiDmToolSearchRequest,
  AiDmToolSearchResult,
} from "@foundry-ai-dungeon-master/shared";

import { digestJson } from "./canonical.js";
import type {
  CatalogSnapshot,
  CatalogToolRecord,
  ProviderToolDefinition,
  ToolCatalogProvider,
  ToolMetadataOverlay,
} from "./types.js";

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function asJson(value: unknown): AiDmJsonValue {
  return value as AiDmJsonValue;
}

function schemaDigest(definition: ProviderToolDefinition): string {
  return digestJson({ input: definition.inputSchema, output: definition.outputSchema });
}

function cloneDefinition(definition: ProviderToolDefinition): ProviderToolDefinition {
  return structuredClone(definition);
}

function toolRevision(
  definition: ProviderToolDefinition,
  metadata: ToolMetadataOverlay,
  digest: string,
): string {
  return digestJson(
    asJson({
      toolId: definition.toolId,
      description: definition.description,
      annotations: definition.annotations ?? {},
      schemaDigest: digest,
      metadata,
    }),
  );
}

function buildDescriptor(
  definition: ProviderToolDefinition,
  metadata: ToolMetadataOverlay,
  digest: string,
): AiDmToolDiscoveryDescriptor {
  const available = metadata.enabled !== false;
  return {
    toolId: definition.toolId,
    revision: toolRevision(definition, metadata, digest),
    displayName: metadata.displayName,
    purpose: metadata.purpose,
    useCases: sorted(metadata.useCases),
    effects: [...metadata.effects].sort(),
    acceptsEntityTypes: sorted(metadata.acceptsEntityTypes),
    producesEntityTypes: sorted(metadata.producesEntityTypes),
    relatedToolIds: sorted(metadata.relatedToolIds),
    risk: metadata.risk,
    approvalPolicy: metadata.approvalPolicy,
    requiredPermissions: sorted(metadata.requiredPermissions),
    availability: available ? "available" : "unavailable",
    ...(metadata.unavailableReasonCode
      ? { unavailableReasonCode: metadata.unavailableReasonCode }
      : {}),
    idempotency: metadata.idempotency,
    schemaRef: `sha256:${digest}`,
    keywords: sorted(metadata.keywords),
  };
}

function principalKinds(principal: AiDmRunPrincipal): Set<"authenticated" | "gm"> {
  return new Set(principal.isGm ? ["authenticated", "gm"] : ["authenticated"]);
}

export function metadataAllows(
  principal: AiDmRunPrincipal,
  metadata: ToolMetadataOverlay,
  operation: "discover" | "execute",
): boolean {
  const kinds = principalKinds(principal);
  const permitted = operation === "discover" ? metadata.discoverableBy : metadata.executableBy;
  return permitted.some((kind) => kinds.has(kind));
}

export function computePolicyViewRevision(
  snapshot: CatalogSnapshot,
  principal: AiDmRunPrincipal,
): string {
  const permitted = [...snapshot.records.values()]
    .filter(
      (record) =>
        record.descriptor.availability === "available" &&
        metadataAllows(principal, record.metadata, "discover"),
    )
    .map((record) => record.descriptor.revision)
    .sort();
  return digestJson({
    catalogRevision: snapshot.catalogRevision,
    policyVersion: snapshot.policyVersion,
    principalUserId: principal.userId,
    isGm: principal.isGm,
    role: principal.role,
    permissionSnapshotRevision: principal.permissionSnapshotRevision,
    permitted,
  });
}

export class TrustedToolCatalog {
  private current: CatalogSnapshot | undefined;
  private readonly metadataById: ReadonlyMap<string, ToolMetadataOverlay>;

  constructor(
    readonly provider: ToolCatalogProvider,
    metadata: readonly ToolMetadataOverlay[],
    readonly policyVersion: string,
  ) {
    const entries = new Map<string, ToolMetadataOverlay>();
    for (const item of metadata) {
      if (entries.has(item.toolId)) {
        throw new Error(`Duplicate tool metadata for '${item.toolId}'.`);
      }
      entries.set(item.toolId, structuredClone(item));
    }
    this.metadataById = entries;
  }

  async refresh(): Promise<CatalogSnapshot> {
    const providerSnapshot = await this.provider.snapshot();
    const definitions = new Map<string, ProviderToolDefinition>();
    for (const definition of providerSnapshot.tools) {
      if (definitions.has(definition.toolId)) {
        throw new Error(`Provider advertised duplicate tool '${definition.toolId}'.`);
      }
      definitions.set(definition.toolId, cloneDefinition(definition));
    }

    const records = new Map<string, CatalogToolRecord>();
    const quarantinedToolIds: string[] = [];
    for (const definition of [...definitions.values()].sort((left, right) =>
      left.toolId.localeCompare(right.toolId),
    )) {
      const metadata = this.metadataById.get(definition.toolId);
      if (!metadata) {
        quarantinedToolIds.push(definition.toolId);
        continue;
      }
      const digest = schemaDigest(definition);
      records.set(definition.toolId, {
        descriptor: buildDescriptor(definition, metadata, digest),
        definition,
        metadata,
        schemaDigest: digest,
      });
    }

    const revisionInput = {
      providerId: providerSnapshot.providerId,
      providerVersion: providerSnapshot.providerVersion,
      providerRevision: providerSnapshot.revision,
      policyVersion: this.policyVersion,
      records: [...records.values()].map(({ descriptor, schemaDigest: digest }) => ({
        descriptor,
        schemaDigest: digest,
      })),
      quarantinedToolIds: sorted(quarantinedToolIds),
    };
    this.current = {
      providerId: providerSnapshot.providerId,
      providerVersion: providerSnapshot.providerVersion,
      providerRevision: providerSnapshot.revision,
      catalogRevision: digestJson(asJson(revisionInput)),
      policyVersion: this.policyVersion,
      records,
      quarantinedToolIds: sorted(quarantinedToolIds),
    };
    return this.current;
  }

  snapshot(): CatalogSnapshot {
    if (!this.current) {
      throw new Error("Tool catalog has not been refreshed.");
    }
    return this.current;
  }

  record(toolId: string): CatalogToolRecord | undefined {
    return this.snapshot().records.get(toolId);
  }

  policyViewRevision(principal: AiDmRunPrincipal): string {
    return computePolicyViewRevision(this.snapshot(), principal);
  }

  searchableRecords(principal: AiDmRunPrincipal): CatalogToolRecord[] {
    return [...this.snapshot().records.values()].filter(
      (record) =>
        record.descriptor.availability === "available" &&
        metadataAllows(principal, record.metadata, "discover"),
    );
  }
}

export interface RankedSearchResult {
  result: AiDmToolSearchResult;
  scores: ReadonlyMap<string, number>;
  normalizedTerms: string[];
}

export type SearchEngine = (
  records: readonly CatalogToolRecord[],
  request: AiDmToolSearchRequest,
  catalogRevision: string,
  policyViewRevision: string,
  searchId: string,
) => RankedSearchResult;
