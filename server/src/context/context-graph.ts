import type {
  AiDmAccessScope,
  AiDmContextDependency,
  AiDmContextNode,
  AiDmJsonValue,
} from "@foundry-ai-dungeon-master/shared";

import { revisionOf } from "./hash.js";
import type { ContextNodeRecord, ParsedCampaignDocument } from "./types.js";
import { ContextError } from "./types.js";
import { mostRestrictiveScope, mostRestrictiveVisibility } from "./visibility-policy.js";

function cloneRecord(record: ContextNodeRecord): ContextNodeRecord {
  return structuredClone(record);
}

function scopeForDerived(
  dependencies: readonly ContextNodeRecord[],
  field: "readScope" | "disclosureScope",
): AiDmAccessScope {
  return mostRestrictiveScope(dependencies.map(({ node }) => node[field]));
}

export class RevisionedContextGraph {
  private readonly records = new Map<string, ContextNodeRecord>();
  private readonly snapshots = new Map<string, ReadonlyMap<string, string>>();
  private graphRevisionValue = revisionOf([]);

  constructor() {
    this.captureSnapshot();
  }

  get revision(): string {
    return this.graphRevisionValue;
  }

  replaceDocument(document: ParsedCampaignDocument): void {
    const incoming = new Set(document.records.map(({ node }) => node.nodeId));
    for (const [nodeId, record] of this.records) {
      if (record.node.sourceUri === document.sourceUri && !incoming.has(nodeId)) {
        this.records.delete(nodeId);
      }
    }
    for (const record of document.records)
      this.records.set(record.node.nodeId, cloneRecord(record));
    this.commitRevision();
  }

  upsert(record: ContextNodeRecord): void {
    this.records.set(record.node.nodeId, cloneRecord(record));
    this.commitRevision();
  }

  getRecord(nodeId: string): ContextNodeRecord | undefined {
    const record = this.records.get(nodeId);
    if (!record) return undefined;
    const cloned = cloneRecord(record);
    cloned.node.stale = this.isStale(record, new Set());
    return cloned;
  }

  allRecords(): ContextNodeRecord[] {
    return [...this.records.values()].map((record) => {
      const cloned = cloneRecord(record);
      cloned.node.stale = this.isStale(record, new Set());
      return cloned;
    });
  }

  addDerivedSummary(input: {
    nodeId: string;
    title: string;
    body: AiDmJsonValue;
    dependencies: AiDmContextDependency[];
    generatorRevision: string;
  }): AiDmContextNode {
    if (input.dependencies.length === 0)
      throw new Error("A derived summary requires dependencies.");
    const dependencyRecords = input.dependencies.map((dependency) => {
      const record = this.records.get(dependency.nodeId);
      if (
        !record ||
        record.node.revision !== dependency.revision ||
        this.isStale(record, new Set())
      ) {
        throw new ContextError("CONTEXT_STALE", `Dependency ${dependency.nodeId} is stale.`);
      }
      return record;
    });
    const node: AiDmContextNode = {
      nodeId: input.nodeId,
      kind: "derived-summary",
      revision: "",
      authoritative: false,
      authority: "derived",
      readScope: scopeForDerived(dependencyRecords, "readScope"),
      disclosureScope: scopeForDerived(dependencyRecords, "disclosureScope"),
      activation: { status: "active", conditionRef: null },
      title: input.title,
      contentType: "application/json",
      body: input.body,
      sourceUri: null,
      sourceHash: null,
      sourceSpan: null,
      edges: [],
      dependencies: structuredClone(input.dependencies),
      stale: false,
    };
    node.revision = revisionOf({
      ...node,
      revision: undefined,
      generatorRevision: input.generatorRevision,
    });
    this.records.set(input.nodeId, {
      node,
      visibility: mostRestrictiveVisibility(dependencyRecords.map(({ visibility }) => visibility)),
      sectionKind: "unclassified",
      edges: [],
    });
    this.commitRevision();
    return structuredClone(node);
  }

  changedNodeIds(sinceRevision: string): string[] {
    const snapshot = this.snapshots.get(sinceRevision);
    if (!snapshot)
      throw new ContextError("CONTEXT_STALE", "The requested graph revision is unavailable.");
    const changed: string[] = [];
    for (const [nodeId, record] of this.records) {
      if (snapshot.get(nodeId) !== record.node.revision) changed.push(nodeId);
    }
    return changed.sort();
  }

  private isStale(record: ContextNodeRecord, visiting: Set<string>): boolean {
    if (record.node.stale) return true;
    if (visiting.has(record.node.nodeId)) return true;
    visiting.add(record.node.nodeId);
    return record.node.dependencies.some((dependency) => {
      const current = this.records.get(dependency.nodeId);
      return (
        !current ||
        current.node.revision !== dependency.revision ||
        this.isStale(current, new Set(visiting))
      );
    });
  }

  private commitRevision(): void {
    this.graphRevisionValue = revisionOf(
      [...this.records.values()]
        .map(({ node }) => [node.nodeId, node.revision])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
    this.captureSnapshot();
  }

  private captureSnapshot(): void {
    this.snapshots.set(
      this.graphRevisionValue,
      new Map([...this.records.values()].map(({ node }) => [node.nodeId, node.revision])),
    );
    while (this.snapshots.size > 128) {
      const oldest = this.snapshots.keys().next().value;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }
  }
}
