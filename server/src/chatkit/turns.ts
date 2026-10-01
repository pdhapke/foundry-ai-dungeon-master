import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";
import { bounded } from "./read-tools.js";
import { CHATKIT_INFERENCE_OPERATIONS } from "@foundry-ai-dungeon-master/shared";

const inference = new Set(CHATKIT_INFERENCE_OPERATIONS);
export class TurnConflict extends Error {}
/** One world queue for every ChatKit inference ingress. Never redispatch an uncertain event. */
export class ChatKitTurns {
  readonly #counts = new Map<string, number>();
  readonly #tails = new Map<string, Promise<void>>();
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS chatkit_turns (world TEXT, event TEXT, owner TEXT, digest TEXT, correlation TEXT, origin TEXT, status TEXT, created INTEGER, PRIMARY KEY(world,event));
      UPDATE chatkit_turns SET status='interrupted' WHERE status IN ('queued','running');`);
  }
  async enter(
    identity: AiDmAuthenticatedIdentity,
    body: unknown,
    signal: AbortSignal,
    transportId?: string,
  ): Promise<(() => void) | undefined> {
    const envelope = body as {
      type?: string;
      params?: { action?: { payload?: { requestId?: unknown } } };
    };
    if (!inference.has(envelope?.type ?? "")) return;
    const hinted = envelope.params?.action?.payload?.requestId ?? transportId;
    if (
      hinted !== undefined &&
      (typeof hinted !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(hinted))
    )
      throw new TurnConflict("Invalid event ID");
    const event = typeof hinted === "string" ? hinted : randomUUID();
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
        /^(area|door|turn)-/.test(event) ? "reviewed-hook-hint" : "foundry-user",
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
    return () => {
      if (done) return;
      done = true;
      status(signal.aborted ? "interrupted" : "settled");
      release();
    };
  }
}
