import assert from "node:assert/strict";
import { test } from "node:test";
import { PreparedContext } from "./prepared-context.js";
const signal = new AbortController().signal;
test("preparation shares work, clones results, bounds age and separates identities/revisions", async () => {
  let now = 0, calls = 0;
  const cache = new PreparedContext<{ value: number }>(15, () => now);
  const build = async () => ({ value: ++calls });
  const [first, concurrent] = await Promise.all([cache.get("world/user/config/role/revision", signal, build), cache.get("world/user/config/role/revision", signal, build)]);
  assert.equal(calls, 1); first.value.value = 900; assert.equal(concurrent.value.value, 1);
  assert.equal((await cache.get("world/user/config/role/revision", signal, build)).hit, true);
  await cache.get("other-world/user/config/role/revision", signal, build);
  await cache.get("world/other-user/config/role/revision", signal, build);
  await cache.get("world/user/config/other-role/revision", signal, build);
  await cache.get("world/user/config/role/new-revision", signal, build);
  assert.equal(calls, 5);
  now = 16; assert.equal((await cache.get("world/user/config/role/revision", signal, build)).hit, false);
});
test("reconnect/missed event invalidation prevents delayed publication", async () => {
  const cache = new PreparedContext<number>();
  let resolve!: (value: number) => void;
  const delayed = cache.get("scope", signal, () => new Promise<number>(done => { resolve = done; }));
  await Promise.resolve(); cache.invalidate(); resolve(1);
  await assert.rejects(delayed, /invalidated/);
  assert.equal((await cache.get("scope", signal, async () => 2)).value, 2);
});
test("cancelled caller does not cancel a concurrent waiter; failed work is retryable", async () => {
  const cache = new PreparedContext<number>();
  const abort = new AbortController(); let resolve!: (value: number) => void;
  const cancelled = cache.get("scope", abort.signal, () => new Promise<number>(done => { resolve = done; }));
  const waiting = cache.get("scope", signal, async () => 9);
  await Promise.resolve(); abort.abort(); resolve(3);
  await assert.rejects(cancelled); assert.equal((await waiting).value, 3);
  cache.invalidate(); await assert.rejects(cache.get("scope", signal, async () => { throw new Error("offline"); }));
  assert.equal((await cache.get("scope", signal, async () => 4)).value, 4);
});
