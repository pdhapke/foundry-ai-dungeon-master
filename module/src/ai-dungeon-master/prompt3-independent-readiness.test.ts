import assert from "node:assert/strict";
import test from "node:test";
import { PanelPreparation, type PanelReadiness } from "./panel-preparation.js";

void test("independent cancelled preparation cannot supersede a reopened panel generation", async () => {
  const completions: Array<(response: Response) => void> = [];
  const signals: AbortSignal[] = [];
  const states: PanelReadiness[] = [];
  const preparation = new PanelPreparation(signal => {
    signals.push(signal);
    return new Promise(resolve => completions.push(resolve));
  }, state => states.push(state));
  const old = preparation.ensure();
  preparation.invalidate("Panel closed.");
  const reopened = preparation.ensure();
  assert.equal(preparation.ensure(), reopened);
  assert.equal(preparation.refresh(), reopened);
  assert.equal(preparation.refresh(), reopened);
  assert.equal(signals[1]!.aborted, false, "manual recovery shares pending work without cancelling it");
  assert.equal(signals[0]!.aborted, true);
  completions[1]!(Response.json({ state: "ready", validUntil: new Date(Date.now() + 60000).toISOString() }));
  await reopened;
  completions[0]!(Response.json({ state: "ready", validUntil: new Date(Date.now() + 60000).toISOString() }));
  await assert.rejects(old, /cancelled/);
  assert.equal(states.at(-1)!.state, "ready");
  await preparation.ensure();
  assert.equal(signals.length, 2);
  preparation.invalidate();
});

void test("independent expiry invalidates without an idle refresh or model request", async () => {
  let calls = 0;
  const states: PanelReadiness[] = [];
  const preparation = new PanelPreparation(async () => {
    calls++;
    return Response.json({ state: "ready", validUntil: new Date(Date.now() + 40).toISOString() });
  }, state => states.push(state));
  await preparation.ensure();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(states.at(-1)!.state, "reconnect-required");
  assert.equal(calls, 1);
  await preparation.ensure();
  assert.equal(calls, 2);
  preparation.invalidate();
});

void test("independent repeated failure demands share bounded retry and invalidation permits recovery", async () => {
  let calls = 0;
  let clock = 10000;
  const preparation = new PanelPreparation(async () => {
    calls++;
    return Response.json({ state: "reconnect-required", retryAfterMs: 999999 }, { status: 503 });
  }, () => {}, () => clock);
  await assert.rejects(preparation.ensure());
  for (let i = 0; i < 10; i++) await assert.rejects(preparation.ensure(), /wait briefly/);
  assert.equal(calls, 1);
  clock += 29999;
  await assert.rejects(preparation.ensure(), /wait briefly/);
  clock++;
  await assert.rejects(preparation.ensure());
  assert.equal(calls, 2);
  preparation.invalidate();
  await assert.rejects(preparation.ensure());
  assert.equal(calls, 3);
  preparation.invalidate();
});
