/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous public endpoint descriptor contract */
import type { ZodType } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { MovementCursorQuery, MovementEventPage, SequencedMovementEvent } from "../../../../foundry-local-api/shared/dist/index.js";
import type { ProtocolError } from "../../../../foundry-local-api/shared/dist/index.js";
import type { ApiExtensionContext } from "../dot-integration/api-contract.js";

/** Generic movement transport supplied by the API extension host. */
export interface MovementStore {
  readonly generation: string;
  cursor(sequence: number): string;
  query(query: MovementCursorQuery): MovementEventPage;
}
export interface MovementDiagnostics {
  configured: boolean; runtimeAvailable: boolean; readable: boolean; valid: boolean;
  version: number | null; generation: string | null; eventCount: number | null;
  nextSequence: number | null; issueCodes: string[];
}
// Match the descriptor contract without importing the API implementation.
export interface AnyEndpointDescriptor {
  name: string; description: string;
  inputSchema?: ZodType<any>; outputSchema?: ZodType<any>;
  handler(input: any, context: any): unknown;
  method?: "get" | "post" | "put" | "delete"; path?: string;
  annotations?: ToolAnnotations;
}
export interface LegacyDeliveryContext extends ApiExtensionContext {
  readonly movement: {
    readonly path: string;
    getStore(): MovementStore | undefined;
    reloadStore(): void;
    diagnose(): MovementDiagnostics;
    onRecord(listener: (record: SequencedMovementEvent) => void): () => void;
    readonly outputSchema: ZodType;
  };
  createProtocolError(body: ConstructorParameters<typeof ProtocolError>[0]): Error;
  registerEndpoints(descriptors: AnyEndpointDescriptor[]): () => void;
}
