import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { completedTurnDefinition, completedTurnInputSchema, dotStateRevision, stateRevisionInputSchema, DotMcpError, type CompletedPlayerTurnInput, type CompletedTurnData, type VerifiedBridgeIdentity, type DotFilters } from "./contract.js";
import { EventService, FileEventStore, PublicHttpsWebhookClient, type EventSecretCodec as DotSecretCodec, type EventStore, type WebhookClient as DotWebhookClient, type McpEventsHttpOptions as DotMcpHttpOptions, type McpToolDefinition as DotToolDefinition } from "../../../../foundry-local-api/server/events-core.js";

export type DotStore = EventStore<DotFilters, CompletedPlayerTurnInput>;

export interface DotController { worldId: string; sceneId: string; clientId: string; userId: string }
export interface DotBinding extends DotController { sessionId: string; controllerId: string }
export interface DotConnectedClient { clientId: string; userId: string; isGM: boolean; lane: string; capabilities: string[] }
export interface DotIntegrationBridge {
  client(): DotConnectedClient | null;
  call(command: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
  receipt(clientId: string, eventId: string, accepted: boolean): void;
}
export interface DotIntegrationSetup {
  enabled: true;
  owner: string;
  controller: DotController;
  /** Trusted account authentication or dedicated single-user private-tunnel origin credential. Never MCP metadata or the administrative API key. */
  authenticate(request: Request, signal: AbortSignal): Promise<string | null>;
  active(): boolean;
  /** Must attest the exact gateway-verified client/world identity; no browser claims. */
  verifyController(binding: DotBinding, client: DotConnectedClient): boolean | Promise<boolean>;
  storagePath: string;
  assertPrivateStorage(path: string): void;
  codec: DotSecretCodec;
  allowedOrigins?: readonly string[];
}
const controllerSchema = z.object({ worldId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sceneId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), clientId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), userId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
const scopeStatusSchema = controllerSchema.extend({ sessionId: z.string().uuid(), controllerId: z.string().uuid(), connected: z.literal(true), isController: z.literal(true), automaticEventsEnabled: z.literal(true) }).strict();
const readSchema = z.object({ state: stateRevisionInputSchema, stateRevision: z.string().regex(/^[a-f0-9]{64}$/), playerCombatantIds: z.array(z.string()).max(256) }).strict();
const eventArgument = z.object({ eventId: z.string().regex(/^turn-[a-f0-9]{64}$/) }).strict();
const scopeArgument = z.object({}).strict();
const publicScopeSchema = z.object({ worldId: controllerSchema.shape.worldId, sessionId: z.string().uuid(), controllerId: z.string().uuid() }).strict();
const responseArgument = eventArgument.extend({ stateRevision: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().min(1).max(12000) }).strict();
const responseSchema = z.object({ outcome: z.enum(["confirmed", "uncertain"]), messageId: z.string().regex(/^[a-f0-9]{16}$/), replayed: z.boolean().optional() }).strict();
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const toolDefinitions: DotToolDefinition[] = [
  { name: "foundry_dot_get_scope", description: "Read this authenticated principal's active subscription scope. Use the returned worldId, sessionId and controllerId as event subscription arguments.", inputSchema: z.toJSONSchema(scopeArgument), outputSchema: z.toJSONSchema(publicScopeSchema), annotations },
  { name: "foundry_dot_read_turn", description: "Read the current authoritative combat state for this controller's retained event. Use its stateRevision when responding.", inputSchema: z.toJSONSchema(eventArgument), outputSchema: z.toJSONSchema(readSchema), annotations },
  { name: "foundry_dot_respond", description: "Publish one plain-text DM response for a retained event using a freshly read stateRevision. Uncertain results require reconciliation with the identical arguments.", inputSchema: z.toJSONSchema(responseArgument), outputSchema: z.toJSONSchema(responseSchema), annotations: { ...annotations, readOnlyHint: false } },
];

/** Store generation persists the scope epoch. Binding every configured identity
 * into the digest prevents another controller/principal from inheriting work.
 * Scope identifiers confer no authority; every use still requires attestation.
 */
function resumableScopeId(kind: "session" | "controller", generation: string, setup: DotIntegrationSetup, controller: DotController): string {
  const hex = createHash("sha256").update(JSON.stringify(["foundry-dot-scope-v1", kind, generation, setup.owner, controller.worldId, controller.sceneId, controller.clientId, controller.userId])).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** Opt-in composition only: construction starts no listener, timer or subscription. */
export class DotIntegration {
  readonly binding: DotBinding;
  readonly events: EventService<DotFilters, CompletedTurnData, CompletedPlayerTurnInput, VerifiedBridgeIdentity>;
  private bound = false;
  private generation = 0;
  private ingressProof: CompletedPlayerTurnInput | undefined;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private worker: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly cancellation = new AbortController();
  constructor(readonly setup: DotIntegrationSetup, readonly bridge: DotIntegrationBridge,
    readonly store: DotStore = new FileEventStore(setup.storagePath, path => setup.assertPrivateStorage(path), completedTurnDefinition), webhooks: DotWebhookClient = new PublicHttpsWebhookClient()) {
    if (setup.enabled !== true || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(setup.owner) || typeof setup.authenticate !== "function" || typeof setup.active !== "function" || typeof setup.verifyController !== "function" || !setup.codec || typeof setup.assertPrivateStorage !== "function") throw new DotMcpError(-32603, "Reviewed dot setup dependencies are required.");
    const controller = controllerSchema.parse(setup.controller), persisted = store.read();
    this.binding = { ...controller, sessionId: resumableScopeId("session", persisted.generation, setup, controller), controllerId: resumableScopeId("controller", persisted.generation, setup, controller) };
    if (persisted.events.some(event => !this.matches(event.input) || event.input.sceneId !== controller.sceneId) ||
      persisted.subscriptions.some(subscription => subscription.owner !== setup.owner || !this.matches(subscription.filters)))
      throw new DotMcpError(-32603, "Retained dot work belongs to another scope; restore its original configuration or perform reviewed recovery before activation.", "scope_recovery_required");
    this.events = new EventService({ definition: completedTurnDefinition, store, codec: setup.codec, webhooks,
      authorizeSubscription: (owner, filters) => this.authorizeEventScope(owner, filters),
      authorizeIngress: (input, identity) => this.ingressProof !== undefined && JSON.stringify(input) === JSON.stringify(this.ingressProof) && identity.clientId === this.binding.clientId && identity.userId === this.binding.userId && identity.lane === "gm",
      canDeliver: (owner, data) => this.authorizeEventScope(owner, data),
    });
  }
  private matches(scope: DotFilters): boolean { return scope.worldId === this.binding.worldId && scope.sessionId === this.binding.sessionId && scope.controllerId === this.binding.controllerId; }
  private async authorizeEventScope(owner: string, scope: DotFilters): Promise<boolean> {
    this.cancellation.signal.throwIfAborted();
    const authorized = owner === this.setup.owner && this.matches(scope) && await this.authorized();
    // Shutdown pauses durable work rather than returning a revocation result.
    this.cancellation.signal.throwIfAborted(); return authorized;
  }
  private async authorized(): Promise<boolean> {
    const client = this.bridge.client();
    if (this.cancellation.signal.aborted || !this.bound || this.setup.active() !== true || !client || client.clientId !== this.binding.clientId || client.userId !== this.binding.userId || !client.isGM || client.lane !== "gm" || !["dotBind", "dotRead", "dotRespond", "dotUnbind", "dotStatus"].every(c => client.capabilities.includes(c))) return false;
    if (await this.setup.verifyController(this.binding, client) !== true) return false;
    try {
      const status = scopeStatusSchema.safeParse(await this.bridge.call("dotStatus", {}));
      return status.success && this.bound && this.setup.active() === true && this.matches(status.data) && status.data.sceneId === this.binding.sceneId && status.data.clientId === this.binding.clientId && status.data.userId === this.binding.userId;
    } catch { return false; }
  }
  async bind(): Promise<boolean> {
    this.bound = false; const generation = ++this.generation; const client = this.bridge.client();
    if (!client || this.setup.active() !== true || client.clientId !== this.binding.clientId || client.userId !== this.binding.userId || !client.isGM || client.lane !== "gm" || await this.setup.verifyController(this.binding, client) !== true) return false;
    const result = await this.bridge.call("dotBind", this.binding) as { bound?: boolean };
    if (generation !== this.generation || this.cancellation.signal.aborted || result?.bound !== true) return false;
    this.bound = true; return await this.authorized();
  }
  disconnected(): void { this.bound = false; this.generation++; }
  private async read(combatId: string): Promise<z.infer<typeof readSchema>> {
    if (!await this.authorized()) throw new DotMcpError(-32003, "Dot controller is inactive.");
    const parsed = readSchema.safeParse(await this.bridge.call("dotRead", { combatId }));
    if (!parsed.success || !this.matches(parsed.data.state) || parsed.data.state.sceneId !== this.binding.sceneId || parsed.data.state.combatId !== combatId || dotStateRevision(parsed.data.state) !== parsed.data.stateRevision || !await this.authorized()) throw new DotMcpError(-32003, "Dot state is invalid or no longer authorized.");
    return parsed.data;
  }
  /** Exact duplicate persisted IDs are reconciled before stale occurrence checks. */
  async ingress(raw: unknown, sender: { clientId: string; userId: string; lane: string }): Promise<void> {
    const parsed = completedTurnInputSchema.safeParse(raw);
    if (!parsed.success || sender.clientId !== this.binding.clientId || sender.userId !== this.binding.userId || sender.lane !== "gm" || !this.matches(parsed.data) || parsed.data.sceneId !== this.binding.sceneId || this.pending >= 32) return;
    this.pending++;
    const work = this.tail.then(async () => {
      const input = parsed.data;
      try {
        if (!await this.authorized()) throw new Error();
        const prior = this.store.read().events.find(e => e.input.eventId === input.eventId);
        if (prior) {
          const withoutTimestamp = (value: CompletedPlayerTurnInput) => JSON.stringify({ ...value, timestamp: "" });
          if (withoutTimestamp(prior.input) !== withoutTimestamp(input)) throw new Error();
        } else {
          const current = await this.read(input.combatId), s = current.state;
          if (current.stateRevision !== input.stateRevision || s.round !== input.next.round || s.turn !== input.next.turn || s.combatantIds[s.turn] !== input.next.combatantId || s.combatantIds[input.previous.turn] !== input.previous.combatantId || !current.playerCombatantIds.includes(input.previous.combatantId) ||
            !((input.next.round === input.previous.round && input.next.turn === input.previous.turn + 1) || (input.next.round === input.previous.round + 1 && input.previous.turn === s.combatantIds.length - 1 && input.next.turn === 0))) throw new Error();
          this.ingressProof = input;
          try { this.events.enqueue(input, { clientId: sender.clientId, userId: sender.userId, lane: "gm" }); } finally { this.ingressProof = undefined; }
        }
        this.bridge.receipt(sender.clientId, input.eventId, true);
      } catch { this.bridge.receipt(sender.clientId, input.eventId, false); }
    });
    this.tail = work.catch(() => undefined);
    try { await work; } finally { this.pending--; }
  }
  private event(owner: string, eventId: string): CompletedPlayerTurnInput {
    const event = this.store.read().events.find(e => e.input.eventId === eventId)?.input;
    if (owner !== this.setup.owner || !event || !this.matches(event) || event.sceneId !== this.binding.sceneId) throw new DotMcpError(-32003, "Dot event is outside the authorized scope.");
    return event;
  }
  httpOptions(): DotMcpHttpOptions { return {
    events: this.events,
    ...(this.setup.allowedOrigins ? { allowedOrigins: this.setup.allowedOrigins } : {}),
    authenticate: (request, signal) => this.setup.authenticate(request, signal),
    scopeForPrincipal: async owner => owner === this.setup.owner && await this.authorized() ? { worldId: this.binding.worldId, sessionId: this.binding.sessionId, controllerId: this.binding.controllerId } : null,
    tools: {
      list: async owner => owner === this.setup.owner && await this.authorized() ? toolDefinitions : [],
      call: async (owner, name, args, signal) => {
        signal.throwIfAborted();
        if (name === "foundry_dot_get_scope") {
          scopeArgument.parse(args);
          if (owner !== this.setup.owner || !await this.authorized()) throw new DotMcpError(-32003, "Dot controller is inactive.");
          signal.throwIfAborted(); const { worldId, sessionId, controllerId } = this.binding; return { worldId, sessionId, controllerId };
        }
        if (name === "foundry_dot_read_turn") { const { eventId } = eventArgument.parse(args); const event = this.event(owner, eventId); return this.read(event.combatId); }
        if (name !== "foundry_dot_respond") throw new DotMcpError(-32602, "Unknown dot tool.");
        const input = responseArgument.parse(args), event = this.event(owner, input.eventId);
        if (!await this.authorized()) throw new DotMcpError(-32003, "Dot controller is inactive.");
        // The native command reconciles an existing write first, then checks fresh
        // state in the same browser immediately before invoking any new mutation.
        signal.throwIfAborted();
        const raw = await this.bridge.call("dotRespond", { ...input, combatId: event.combatId, cancellationId: randomUUID() }, AbortSignal.any([signal, this.cancellation.signal]));
        const response = responseSchema.safeParse(raw);
        if (!response.success) throw new DotMcpError(-32603, "Dot response reconciliation is required.");
        return response.data;
      },
    },
  }; }
  start(): void {
    if (this.running || this.cancellation.signal.aborted) return;
    this.running = true; this.schedule();
  }
  private schedule(): void {
    if (!this.running || this.cancellation.signal.aborted) return;
    this.worker = setTimeout(() => {
      this.worker = undefined;
      void (async () => {
        if (await this.authorized()) await this.events.dispatchDue(this.cancellation.signal);
      })().catch(() => { /* Durable state retains failures; no secrets in logs. */ }).finally(() => this.schedule());
    }, 1000); this.worker.unref();
  }
  async stop(): Promise<void> {
    this.running = false; this.disconnected(); this.cancellation.abort(); if (this.worker) clearTimeout(this.worker); this.worker = undefined;
    // Process shutdown preserves subscriptions and unfinished deliveries for
    // exact-controller restart. Explicit events/unsubscribe remains durable stop.
    await this.bridge.call("dotUnbind", {}).catch(() => undefined);
  }
}
