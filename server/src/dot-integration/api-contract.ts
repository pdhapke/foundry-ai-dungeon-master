import type { RequestHandler } from "express";

/** Public API extension v1. No gateway implementation or AI settings cross this boundary. */
export interface ClientSelector { clientId?: string; userId?: string; lane?: "gm" | "player" | "tv" }
export interface ApiClient { clientId: string; userId: string; isGM: boolean; lane: string; capabilities: string[] }
export interface VerifiedIdentity { worldId: string; userId: string; role: number; isGM: boolean }
export interface EventSender { clientId: string; userId: string; lane: string }
export interface GenericBridge {
  getClient(selector?: ClientSelector): ApiClient | null;
  getVerifiedFoundryIdentity(selector: ClientSelector): VerifiedIdentity | null;
  send(raw: string, selector?: ClientSelector): boolean;
}
export interface ApiExtensionContext {
  readonly version: 1;
  readonly runtimeRoot: URL;
  readonly moduleRoot: URL;
  readonly bindHost: string;
  readonly administrativeCredentialSha256: string;
  readonly bridge: GenericBridge;
  call(command: string, payload: unknown, selector: ClientSelector): Promise<unknown>;
  registerPrivateChannel(kind: string, handler: (payload: unknown, sender: EventSender, current: () => boolean) => Promise<void>): () => void;
  registerEventHandler(name: string, handler: (payload: unknown, metadata: EventSender) => void | Promise<void>): () => void;
  /** Non-consuming event observer. Optional: older Local API builds do not provide it. */
  observeEvent?(name: string, handler: (payload: unknown, metadata: EventSender) => void | Promise<void>): () => void;
  onConnectionEstablished(handler: (client: ApiClient) => void): () => void;
  onConnectionLost(handler: (client: ApiClient) => void): () => void;
  registerRoute(path: string, handler: RequestHandler): () => void;
  onShutdown(handler: () => void | Promise<void>): () => void;
}
