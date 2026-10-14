import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";
import type { AiDmMutationBoundaryAcknowledgement } from "@foundry-ai-dungeon-master/shared";
import { bounded } from "./read-tools.js";
import { CHATKIT_INFERENCE_OPERATIONS } from "@foundry-ai-dungeon-master/shared";
import { z } from "zod";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const automaticHint = z
  .object({
    kind: z.enum(["area", "door", "turn"]),
    worldId: identifier,
    sceneId: identifier,
    documentId: identifier,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    transition: z.string().min(1).max(256),
    tokenId: identifier.optional(),
    regionId: identifier.optional(),
    key: identifier.optional(),
  })
  .strict();

const inference = new Set(CHATKIT_INFERENCE_OPERATIONS);
export class TurnConflict extends Error {}
export interface ChatKitTurnLease {
  (): void;
  releaseForNarration(boundary: AiDmMutationBoundaryAcknowledgement): void;
}
/** One world queue for every ChatKit inference ingress. Never redispatch an uncertain event. */
export class ChatKitTurns {
  readonly #counts = new Map<string, number>();
  readonly #tails = new Map<string, Promise<void>>();
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS chatkit_turns (world TEXT, event TEXT, owner TEXT, digest TEXT, correlation TEXT, origin TEXT, status TEXT, created INTEGER, PRIMARY KEY(world,event));
      UPDATE chatkit_turns SET status='interrupted' WHERE status IN ('queued','running','narrating');
      CREATE TABLE IF NOT EXISTS chatkit_narration_boundaries(world TEXT,event TEXT,receipt_digest TEXT,state_revision TEXT,created INTEGER,PRIMARY KEY(world,event));`);
  }
  /** Browser campaign decisions share the inference queue without making a model call.
   * Durable proposal IDs own decision replay; each transport gets a fresh queue event.
   */
  enterAction(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    signal: AbortSignal,
  ): Promise<ChatKitTurnLease | undefined> {
    return this.enter(
      identity,
      {
        type: "threads.custom_action",
        params: { action: { type: "campaign.browser-decision", payload: { review: body } } },
      },
      signal,
    );
  }
  async enter(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    signal: AbortSignal,
    transportId?: string,
  ): Promise<ChatKitTurnLease | undefined> {
    const envelope = body as {
      type?: string;
      params?: { action?: { payload?: { requestId?: unknown; automatic?: unknown } } };
    };
    if (!inference.has(envelope?.type ?? "")) return;
    const hinted = envelope.params?.action?.payload?.requestId ?? transportId;
    if (
      hinted !== undefined &&
      (typeof hinted !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(hinted))
    )
      throw new TurnConflict("Invalid event ID");
    const event = typeof hinted === "string" ? hinted : randomUUID();
    const automatic = envelope.params?.action?.payload?.automatic;
    if (automatic !== undefined) {
      const parsed = automaticHint.safeParse(automatic);
      if (!parsed.success || !identity.isGm || parsed.data.worldId !== identity.worldId)
        throw new TurnConflict("Automatic event world or schema mismatch");
      const hint = parsed.data;
      if (hint.kind === "area" && (!hint.tokenId || !hint.regionId || !hint.key))
        throw new TurnConflict("Keyed area observation incomplete");
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            hint.kind,
            hint.worldId,
            hint.sceneId,
            hint.documentId,
            hint.tokenId ?? null,
            hint.regionId ?? null,
            hint.key ?? null,
            hint.revision,
            hint.transition,
          ]),
        )
        .digest("hex");
      if (event !== `${hint.kind}-${digest}`)
        throw new TurnConflict("Automatic event identity mismatch");
    }
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const prior = this.db
      .prepare("SELECT owner,digest,status FROM chatkit_turns WHERE world=? AND event=?")
      .get(identity.worldId, event);
    if (prior)
      throw new TurnConflict(
        `Event already recorded (${String(prior["status"])}); inspect conversation/receipts before issuing a new action`,
      );
    if ((this.#counts.get(identity.worldId) ?? 0) >= 32)
      throw new TurnConflict("World turn queue is full");
    this.#counts.set(identity.worldId, (this.#counts.get(identity.worldId) ?? 0) + 1);
    this.db
      .prepare("INSERT INTO chatkit_turns VALUES (?,?,?,?,?,?,?,?)")
      .run(
        identity.worldId,
        event,
        identity.userId,
        digest,
        event,
        automatic !== undefined
          ? "authenticated-gm-observation-hint"
          : "authenticated-foundry-user",
        "queued",
        Date.now(),
      );
    const previous = this.#tails.get(identity.worldId) ?? Promise.resolve();
    let unlock!: () => void;
    const tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.#tails.set(
      identity.worldId,
      previous.then(() => tail),
    );
    const release = () => {
      this.#counts.set(identity.worldId, (this.#counts.get(identity.worldId) ?? 1) - 1);
      unlock();
    };
    const status = (value: string) =>
      this.db
        .prepare("UPDATE chatkit_turns SET status=? WHERE world=? AND event=?")
        .run(value, identity.worldId, event);
    try {
      await bounded(previous, signal);
      if (signal.aborted) throw new Error("Cancelled");
      status("running");
    } catch (error) {
      status("cancelled");
      release();
      throw error;
    }
    let done = false;
    let mutationReleased = false;
    const finish = (() => {
      if (done) return;
      done = true;
      status(signal.aborted ? "interrupted" : "settled");
      if (!mutationReleased) { mutationReleased = true; release(); }
    }) as ChatKitTurnLease;
    finish.releaseForNarration = (boundary) => {
      if (done || signal.aborted) throw new TurnConflict("Turn no longer active");
      if (boundary.version !== 1 || boundary.mutationCapability !== "permanently-revoked" || !/^[a-f0-9]{64}$/.test(boundary.receiptDigest) || !/^[a-f0-9]{64}$/.test(boundary.stateRevision))
        throw new TurnConflict("Invalid permanent boundary");
      if (mutationReleased) return;
      // Persist the irreversible transition before resolving the world tail.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT INTO chatkit_narration_boundaries VALUES (?,?,?,?,?)").run(identity.worldId, event, boundary.receiptDigest, boundary.stateRevision, Date.now());
        status("narrating");
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      mutationReleased = true;
      release();
    };
    return finish;
  }
}
