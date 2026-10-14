export const DOT_EVENT = "foundry.player_turn_completed";
export const DOT_BIND_REQUEST = "foundry.dot_controller_requested";
export interface DotBinding { worldId: string; sessionId: string; controllerId: string; sceneId: string; clientId: string; userId: string }
export interface DotScope extends DotBinding { connected: boolean; isController: boolean; automaticEventsEnabled: boolean }
export interface DotState { worldId: string; sessionId: string; controllerId: string; sceneId: string; combatId: string; combatModifiedTime: number; round: number; turn: number; combatantIds: string[]; paused: boolean }
export interface DotTurn { eventId: string; timestamp: string; worldId: string; sessionId: string; controllerId: string; sceneId: string; combatId: string; stateRevision: string; previous: { round: number; turn: number; combatantId: string }; next: { round: number; turn: number; combatantId: string } }
export interface DotStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const dotCanonical = (s: DotState): string => JSON.stringify(["foundry-dot-state-v1", s.worldId, s.sessionId, s.controllerId, s.sceneId, s.combatId, s.combatModifiedTime, s.round, s.turn, s.combatantIds, s.paused]);
export async function dotDigest(text: string): Promise<string> { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join(""); }
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
interface PendingTurn { input: DotTurn; attempts: number; next: number; status: "queued" | "dead_letter" }
interface ResponseReceipt { fingerprint: string; status: "pending" | "confirmed"; messageId: string }
export interface DotResponseInput { eventId: string; combatId: string; stateRevision: string; text: string; cancellationId?: string }
export interface DotNative {
  authority(binding: DotBinding): boolean;
  state(binding: DotBinding, combatId: string): { state: DotState; playerCombatantIds: string[] } | undefined;
  findMessage(messageId: string): Record<string, unknown> | undefined;
  createMessage(data: Record<string, unknown>): Promise<Record<string, unknown>>;
}
/** No credentials or callback URLs are persisted. Storage failures refuse activation/submission. */
export class DotBridge {
  private binding: DotBinding | undefined;
  private connected = false;
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Map<string, Set<{ resolve(): void; reject(error: Error): void }>>();
  private turns: PendingTurn[] = [];
  private receipts: Record<string, ResponseReceipt> = {};
  private healthy = false;
  private responseTail: Promise<unknown> = Promise.resolve();
  private readonly responseCancellations = new Map<string, AbortController>();
  constructor(readonly clientId: string, readonly userId: string, private readonly storage: DotStorage | undefined,
    private readonly native: DotNative, private readonly send: (event: string, payload: unknown) => void, private readonly now = Date.now) {
    try {
      const raw = storage?.getItem(this.key);
      if (raw && raw.length > 262144) throw new Error();
      const data = raw ? JSON.parse(raw) as { version: number; turns: PendingTurn[]; receipts: Record<string, ResponseReceipt> } : { version: 1, turns: [], receipts: {} };
      if (data.version !== 1 || !Array.isArray(data.turns) || data.turns.length > 64 || !data.receipts || Object.keys(data.receipts).length > 1024 ||
        data.turns.some(t => !t || !/^turn-[a-f0-9]{64}$/.test(t.input?.eventId) || !Number.isSafeInteger(t.attempts) || t.attempts < 0 || t.attempts > 5 || !Number.isSafeInteger(t.next) || !["queued", "dead_letter"].includes(t.status))) throw new Error();
      this.turns = data.turns; this.receipts = data.receipts;
      this.persist(); this.healthy = true;
    } catch { this.healthy = false; }
  }
  private get key(): string { return `foundry-local-api.dot.v1.${this.userId}.${this.clientId}`; }
  private persist(): void {
    if (!this.storage) throw new Error("Private browser storage is unavailable.");
    const raw = JSON.stringify({ version: 1, turns: this.turns, receipts: this.receipts });
    if (raw.length > 262144) throw new Error("Dot bridge storage capacity reached.");
    try { this.storage.setItem(this.key, raw); if (this.storage.getItem(this.key) !== raw) throw new Error(); }
    catch { this.healthy = false; throw new Error("Dot bridge storage failed."); }
  }
  onLifecycle = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private changed(): void { for (const listener of this.listeners) listener(); }
  setConnected(connected: boolean): void { if (this.connected !== connected) { this.connected = connected; this.changed(); } }
  /** Bounded lifecycle hint only; server identity verification remains authoritative. */
  requestBinding(): void { if (this.connected) { this.changed(); this.send(DOT_BIND_REQUEST, {}); } }
  bind(raw: unknown): Record<string, unknown> {
    const b = raw as DotBinding;
    if (!b || Object.keys(b).sort().join() !== "clientId,controllerId,sceneId,sessionId,userId,worldId" || !Object.values(b).every(identifier) ||
      b.clientId !== this.clientId || b.userId !== this.userId || !this.connected || !this.healthy || !this.native.authority(b)) throw new Error("Dot binding refused.");
    this.binding = { ...b }; this.changed(); return { bound: true, ...b };
  }
  unbind(): void { this.binding = undefined; this.changed(); }
  getScope = (): DotScope | undefined => {
    const b = this.binding;
    try { if (!b || !this.healthy || !this.native.authority(b)) return; } catch { return; }
    return { ...b, connected: this.connected, isController: true, automaticEventsEnabled: true };
  };
  currentState = (combatId: string): DotState | undefined => {
    const b = this.getScope(); if (!b?.connected || !identifier(combatId)) return;
    return this.native.state(b, combatId)?.state;
  };
  async read(combatId: string): Promise<Record<string, unknown>> {
    const b = this.getScope(); if (!b?.connected) throw new Error("Dot controller is inactive.");
    const read = this.native.state(b, combatId); if (!read) throw new Error("Dot combat state is unavailable.");
    const canonical = dotCanonical(read.state); const stateRevision = await dotDigest(canonical);
    if (dotCanonical(this.currentState(combatId) ?? {} as DotState) !== canonical) throw new Error("Dot state changed during read.");
    return { ...read, stateRevision };
  }
  submitCompletedTurn = async (input: DotTurn, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted(); const scope = this.getScope();
    if (!scope?.connected || input.worldId !== scope.worldId || input.sessionId !== scope.sessionId || input.controllerId !== scope.controllerId || input.sceneId !== scope.sceneId ||
      !/^turn-[a-f0-9]{64}$/.test(input.eventId) || JSON.stringify(input).length > 4096) throw new Error("Dot submission refused.");
    const existing = this.turns.find(t => t.input.eventId === input.eventId);
    if (existing && JSON.stringify({ ...existing.input, timestamp: "" }) !== JSON.stringify({ ...input, timestamp: "" })) throw new Error("Dot event identity conflict.");
    if (!existing) { if (this.turns.length >= 64) throw new Error("Dot outbox is full."); this.turns.push({ input: structuredClone(input), attempts: 0, next: this.now(), status: "queued" }); this.persist(); }
    if (existing?.status === "dead_letter") throw new Error("Dot delivery requires reconciliation.");
    await new Promise<void>((resolve, reject) => {
      const entries = this.waiters.get(input.eventId) ?? new Set();
      const entry = { resolve: () => { cleanup(); resolve(); }, reject: (error: Error) => { cleanup(); reject(error); } };
      const abort = () => entry.reject(new Error("Dot handoff cancelled; persisted event requires reconciliation."));
      const timer = setTimeout(() => entry.reject(new Error("Dot acknowledgement is uncertain; persisted event retained.")), 25000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); entries.delete(entry); if (!entries.size) this.waiters.delete(input.eventId); };
      entries.add(entry); this.waiters.set(input.eventId, entries); signal.addEventListener("abort", abort, { once: true }); this.pump();
    });
  };
  pump(): void {
    const b = this.getScope(); if (!b?.connected) return;
    for (const record of this.turns) {
      if (record.status !== "queued" || record.next > this.now()) continue;
      if (record.input.sessionId !== b.sessionId || record.input.controllerId !== b.controllerId || record.attempts >= 5) {
        record.status = "dead_letter"; this.persist(); for (const w of this.waiters.get(record.input.eventId) ?? []) w.reject(new Error("Dot delivery requires reconciliation.")); continue;
      }
      record.attempts++; record.next = this.now() + Math.min(16000, 1000 * 2 ** (record.attempts - 1)); this.persist();
      this.send(DOT_EVENT, record.input);
    }
  }
  /** Explicit operator reconciliation retries transport only, preserving the exact event identity. */
  reconcileCompletedTurn = async (eventId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const record = this.turns.find(t => t.input.eventId === eventId);
    if (!record) throw new Error("No retained dot handoff to reconcile.");
    const scope = this.getScope();
    if (!scope?.connected || scope.sessionId !== record.input.sessionId || scope.controllerId !== record.input.controllerId) throw new Error("Dot handoff scope is no longer active.");
    record.attempts = 0; record.status = "queued"; record.next = this.now(); this.persist();
    return this.submitCompletedTurn(record.input, signal);
  };
  receive(raw: unknown): boolean {
    const control = raw as { kind?: string; clientId?: string; cancellationId?: string };
    if (control?.kind === "dot-cancel-response") {
      if (control.clientId === this.clientId && typeof control.cancellationId === "string" && /^[a-f0-9-]{36}$/.test(control.cancellationId)) {
        let cancellation = this.responseCancellations.get(control.cancellationId);
        if (!cancellation && this.responseCancellations.size < 256) { cancellation = new AbortController(); this.responseCancellations.set(control.cancellationId, cancellation); }
        cancellation?.abort();
      }
      return true;
    }
    const ack = raw as { kind?: string; clientId?: string; eventId?: string; accepted?: boolean };
    if (ack?.kind !== "dot-receipt") return false;
    if (ack.clientId !== this.clientId || typeof ack.eventId !== "string") return true;
    const record = this.turns.find(t => t.input.eventId === ack.eventId); if (!record) return true;
    if (ack.accepted === true) { this.turns = this.turns.filter(t => t !== record); this.persist(); for (const w of this.waiters.get(ack.eventId) ?? []) w.resolve(); }
    else { record.status = "dead_letter"; this.persist(); for (const w of this.waiters.get(ack.eventId) ?? []) w.reject(new Error("Dot event was refused.")); }
    return true;
  }
  respond(input: DotResponseInput): Promise<Record<string, unknown>> {
    const requestId = input.cancellationId ?? crypto.randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(requestId) || this.responseCancellations.size >= 256) return Promise.reject(new Error("Dot response cancellation capacity reached."));
    const cancellation = this.responseCancellations.get(requestId) ?? new AbortController();
    this.responseCancellations.set(requestId, cancellation);
    const next = this.responseTail.then(() => this.publish({ ...input }, cancellation.signal)).finally(() => this.responseCancellations.delete(requestId));
    this.responseTail = next.catch(() => undefined); return next;
  }
  private async publish(input: DotResponseInput, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!input || Object.keys(input).filter(key => key !== "cancellationId").sort().join() !== "combatId,eventId,stateRevision,text" || !/^turn-[a-f0-9]{64}$/.test(input.eventId) || !/^[a-f0-9]{64}$/.test(input.stateRevision) || !identifier(input.combatId) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 12000) throw new Error("Invalid dot response.");
    const scope = this.getScope(); if (!scope?.connected) throw new Error("Dot controller is inactive.");
    const fingerprint = await dotDigest(JSON.stringify([scope.worldId, scope.sessionId, scope.controllerId, input.combatId, input.stateRevision, input.text]));
    const messageId = (await dotDigest(JSON.stringify(["dot-response-v1", scope.worldId, scope.sessionId, scope.controllerId, input.eventId]))).slice(0, 16);
    const prior = this.receipts[input.eventId];
    if (prior && prior.fingerprint !== fingerprint) throw new Error("Dot response identity conflict.");
    const existing = this.native.findMessage(messageId);
    if (existing) {
      const flags = (existing.flags as Record<string, Record<string, unknown>> | undefined)?.["foundry-local-api"];
      if (flags?.dotFingerprint !== fingerprint || flags?.dotEventId !== input.eventId) throw new Error("Dot response document identity conflict.");
      this.receipts[input.eventId] = { fingerprint, status: "confirmed", messageId }; this.persist(); return { outcome: "confirmed", messageId, replayed: true };
    }
    if (prior) return { outcome: "uncertain", messageId, replayed: true };
    signal.throwIfAborted();
    if (Object.keys(this.receipts).length >= 1024) throw new Error("Dot response ledger is full.");
    const current = await this.read(input.combatId);
    if (current.stateRevision !== input.stateRevision || this.binding?.sessionId !== scope.sessionId || this.binding?.controllerId !== scope.controllerId) throw new Error("Stale dot response refused.");
    signal.throwIfAborted();
    this.receipts[input.eventId] = { fingerprint, status: "pending", messageId }; this.persist();
    // Recheck synchronously after reservation: no await before native create invocation.
    const finalState = this.currentState(input.combatId);
    if (!finalState || !this.getScope()?.connected || dotCanonical(finalState) !== dotCanonical(current.state as DotState)) return { outcome: "uncertain", messageId };
    const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    try {
      signal.throwIfAborted();
      await this.native.createMessage({ _id: messageId, content: `<p>${escape(input.text).replace(/\n/g, "<br>")}</p>`, speaker: { alias: "Dungeon Master" }, flags: { "foundry-local-api": { dotEventId: input.eventId, dotFingerprint: fingerprint } } });
      const observed = this.native.findMessage(messageId);
      const observedFlags = (observed?.flags as Record<string, Record<string, unknown>> | undefined)?.["foundry-local-api"];
      if (observedFlags?.dotFingerprint !== fingerprint || observedFlags?.dotEventId !== input.eventId) return { outcome: "uncertain", messageId };
      this.receipts[input.eventId] = { fingerprint, status: "confirmed", messageId }; this.persist(); return { outcome: "confirmed", messageId, replayed: false };
    } catch { return { outcome: "uncertain", messageId }; }
  }
}

export function registerDotCommands(bridge: DotBridge, registerCommand: (type: string, handler: (payload: unknown) => unknown) => () => void): (() => void)[] {
  const disposers: (() => void)[] = [];
  try {
    disposers.push(registerCommand("dotBind", (payload: unknown) => bridge.bind(payload)));
    disposers.push(registerCommand("dotUnbind", () => { bridge.unbind(); return { bound: false }; }));
    disposers.push(registerCommand("dotRead", (payload: unknown) => bridge.read((payload as { combatId: string }).combatId)));
    disposers.push(registerCommand("dotStatus", () => bridge.getScope() ?? null));
    disposers.push(registerCommand("dotRespond", (payload: unknown) => bridge.respond(payload as Parameters<DotBridge["respond"]>[0])));
    return disposers;
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
}

export const foundryDotNative: DotNative = {
  authority: b => game.world?.id === b.worldId && game.user?.id === b.userId && game.user.isGM && game.user.active === true && canvas?.scene?.id === b.sceneId && game.settings.get("foundry-ai-dungeon-master", "automaticEventsEnabled") === true && game.settings.get("foundry-ai-dungeon-master", "dmEventMode") === "dot",
  state(b, combatId) {
    const combat = game.collections.get("Combat")?.get(combatId) as unknown as { id: string; active: boolean; scene?: { id: string } | string; _stats?: { modifiedTime?: number }; round: number; turn: number; turns: { id: string; actor?: { hasPlayerOwner?: boolean } }[] } | undefined;
    if (!combat?.active || (typeof combat.scene === "string" ? combat.scene : combat.scene?.id) !== b.sceneId || !Number.isSafeInteger(combat._stats?.modifiedTime) || !Number.isSafeInteger(combat.round) || combat.round < 1 || !Number.isSafeInteger(combat.turn) || combat.turn < 0 || !Array.isArray(combat.turns) || !combat.turns.length || combat.turns.length > 256 || combat.turn >= combat.turns.length || !combat.turns.every(t => identifier(t.id)) || new Set(combat.turns.map(t => t.id)).size !== combat.turns.length || typeof game.paused !== "boolean") return;
    return { state: { worldId: b.worldId, sessionId: b.sessionId, controllerId: b.controllerId, sceneId: b.sceneId, combatId, combatModifiedTime: combat._stats!.modifiedTime!, round: combat.round, turn: combat.turn, combatantIds: combat.turns.map(t => t.id), paused: game.paused }, playerCombatantIds: combat.turns.filter(t => t.actor?.hasPlayerOwner === true).map(t => t.id) };
  },
  findMessage: id => game.collections.get("ChatMessage")?.get(id)?.toObject(),
  async createMessage(data) { const cls = CONFIG["ChatMessage"]?.documentClass; if (!cls) throw new Error("Chat messages unavailable."); const result = await cls.create(data, { keepId: true }); if (!result) throw new Error("Chat write uncertain."); return result.toObject(); },
};
