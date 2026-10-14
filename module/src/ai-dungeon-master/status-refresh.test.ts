import assert from "node:assert/strict";
import test from "node:test";
import { StatusRefresh } from "./status-refresh.js";

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
void test("concurrent events share actual pending reply and successful status is briefly cached", async () => {
  let complete!: () => void;
  let calls = 0,
    now = 0;
  const status = new StatusRefresh(
    () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    () => true,
    { now: () => now },
  );
  const opening = status.open();
  assert.equal(status.refresh(), opening);
  assert.equal(status.refresh(), opening);
  assert.equal(calls, 1);
  complete();
  await opening;
  await status.refresh();
  assert.equal(calls, 1);
  now = 1001;
  const fresh = status.refresh();
  assert.equal(calls, 2);
  complete();
  await fresh;
  status.close();
});

void test("meaningful invalidations during a pending reply queue one fresh follow-up", async () => {
  let complete!: () => void;
  let calls = 0;
  const status = new StatusRefresh(
    () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    () => true,
  );
  const first = status.open();
  status.invalidate();
  status.invalidate();
  complete();
  await first;
  assert.equal(calls, 2);
  const second = status.refresh();
  complete();
  await second;
  assert.equal(calls, 2);
  status.close();
});

void test("failures retry at most twice with backoff; external bursts do not bypass scheduled retry", async () => {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let calls = 0,
    sequence = 0;
  const status = new StatusRefresh(
    async () => {
      calls++;
      throw new Error("offline");
    },
    () => true,
    {
      schedule: (callback, delay) => {
        delays.push(delay);
        timers.set(++sequence, callback);
        return sequence as unknown as ReturnType<typeof setTimeout>;
      },
      unschedule: (id) => {
        timers.delete(id as unknown as number);
      },
    },
  );
  await assert.rejects(status.open(), /offline/);
  await status.invalidate();
  await status.refresh();
  assert.equal(calls, 1);
  timers.get(1)!();
  await flush();
  assert.equal(calls, 2);
  timers.get(2)!();
  await flush();
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 3000]);
  status.close();
});

void test("close aborts only status work, cancels backoff, fences stale callbacks, and reopen works", async () => {
  let signal!: AbortSignal;
  let complete!: () => void;
  let calls = 0;
  const status = new StatusRefresh(
    (s) => {
      signal = s;
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    () => true,
  );
  const first = status.open();
  status.close();
  assert.equal(signal.aborted, true);
  complete();
  await first;
  const second = status.open();
  assert.equal(calls, 2);
  complete();
  await second;
  status.close();
  let eligible = false;
  const unavailable = new StatusRefresh(
    async () => {
      calls++;
    },
    () => eligible,
  );
  await unavailable.open();
  assert.equal(calls, 2);
  eligible = true;
  await unavailable.invalidate();
  assert.equal(calls, 3);
  unavailable.close();
});

void test("close removes scheduled retry and late callback cannot issue a request", async () => {
  let callback!: () => void;
  let removed = false,
    calls = 0;
  const status = new StatusRefresh(
    async () => {
      calls++;
      throw new Error("offline");
    },
    () => true,
    {
      schedule: (cb) => {
        callback = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      unschedule: () => {
        removed = true;
      },
    },
  );
  await assert.rejects(status.open());
  status.close();
  callback();
  await flush();
  assert.equal(removed, true);
  assert.equal(calls, 1);
});
