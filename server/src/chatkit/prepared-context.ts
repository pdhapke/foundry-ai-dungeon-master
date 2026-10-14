import { bounded } from "./bounded-call.js";

/** Bounded preparation metadata only. Source content stays in its existing validated owner. */
export class PreparedContext<T> {
  private entries = new Map<string, { at: number; value: T; generation: number }>();
  private pending = new Map<string, Promise<T>>();
  private generation = 0;
  constructor(private readonly ttlMs = 15_000, private readonly now = Date.now, private readonly maximum = 32) {}
  invalidate(): void { this.generation++; this.entries.clear(); this.pending.clear(); }
  async get(key: string, signal: AbortSignal, build: () => Promise<T>): Promise<{ value: T; hit: boolean; ageMs: number }> {
    signal.throwIfAborted();
    const prior = this.entries.get(key);
    if (prior && prior.generation === this.generation && this.now() - prior.at < this.ttlMs)
      return { value: structuredClone(prior.value), hit: true, ageMs: Math.max(0, this.now() - prior.at) };
    let work = this.pending.get(key);
    if (!work) {
      if (this.pending.size >= this.maximum) throw new Error("Preparation concurrency limit reached");
      const generation = this.generation;
      work = bounded(Promise.resolve().then(build), AbortSignal.timeout(10_000)).then(value => {
        if (generation !== this.generation) throw new Error("Preparation invalidated during refresh");
        if (this.entries.size >= this.maximum) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, { at: this.now(), value: structuredClone(value), generation });
        return value;
      });
      this.pending.set(key, work);
      const owned = work;
      void work.finally(() => { if (this.pending.get(key) === owned) this.pending.delete(key); }).catch(() => {});
    }
    const value = await bounded(work, signal);
    signal.throwIfAborted();
    return { value: structuredClone(value), hit: false, ageMs: 0 };
  }
}
