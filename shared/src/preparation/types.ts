/** Versioned, private proposals; these contracts grant no Foundry mutation or spend. */
export type PreparationStage = "area" | "map" | "population";
export interface PreparationCaller {
  worldId: string;
  isGm: boolean;
}
export interface PreparationJobInput {
  worldId: string;
  requestId: string;
  areaIds: string[];
  sourceRevisions: Record<string, string>;
  depth: "outline" | "encounter";
  maxAreas: number;
  desiredReadiness: "records" | "map" | "population";
  /** Informational only. Approval cannot be issued through this input. */
  generationBudget?: { approvalId: string; maximumRequests: number };
}
export interface PreparationAreaSource {
  id: string;
  revision: string;
  title: string;
  travelLinks: string[];
  entryPoints: string[];
  encounterRecordIds: string[];
}
export interface PreparationMapCandidate {
  areaId: string;
  assetRef: string;
  source: string;
  license: string;
  width: number;
  height: number;
  grid: { size: number; distance: number; units: string; originX: number; originY: number };
  profile: "preparation-only" | "verified-tv";
  landmarks: {
    x: number;
    y: number;
    gridColumn: number;
    gridRow: number;
    residualPixels: number;
  }[];
  alignmentTolerancePixels: number;
}
export interface PreparationPopulationProposal {
  areaId: string;
  tokens: {
    preparationId: string;
    actorId: string;
    recordId: string;
    x: number;
    y: number;
    size: number;
    hidden: boolean;
    elevation?: number;
    disposition?: -1 | 0 | 1;
    actorLink?: boolean;
  }[];
  gmNoteRecordIds: string[];
  traps: {
    recordId: string;
    activation: "never-during-preparation";
    mechanics: "manual" | "unsupported";
    region: { x: number; y: number; width: number; height: number };
    triggerConditions: string;
    detectionConditions: string;
    consequences: string;
    activationState: "inactive";
  }[];
}
export interface PreparationJob {
  version: 1;
  id: string;
  input: PreparationJobInput;
  revision: number;
  state: "queued" | "paused" | "cancelled" | "needs-review";
  stages: Partial<Record<PreparationStage, { digest: string; proposals: unknown[] }>>;
  readiness: {
    records: boolean;
    map: boolean;
    population: boolean;
    visibility: false;
    trapMechanics: false;
    liveAccepted: false;
  };
  warnings: string[];
  spending: { requests: 0; generationExecuted: false };
  nativeReceipts?: Record<string, { sceneId: string; sceneRevision: string; receiptId: string }>;
}
