import assert from "node:assert/strict";
import test from "node:test";
import { PanelPreparation, type PanelReadiness } from "./panel-preparation.js";
const ready = () => Response.json({ state: "ready", validUntil: new Date(Date.now() + 10000).toISOString() });
void test("manual recovery bursts share current preparation without cancelling it", async () => {
  let complete!: (value: Response) => void;
  let calls = 0;
  let signal!: AbortSignal;
  const preparation = new PanelPreparation(s => { signal = s; calls++; return new Promise(resolve => { complete = resolve; }); }, () => undefined);
  const opening = preparation.ensure();
  assert.equal(preparation.refresh(), opening); assert.equal(preparation.refresh(), opening);
  assert.equal(signal.aborted, false); complete(ready()); await opening;
  assert.equal(calls, 1); preparation.invalidate();
});
void test("preparation failures expose only safe corrective categories, never backend content", async () => {
  for (const [reason, pattern] of [["context-action-required", /model context/], ["privacy-action-required", /storage requires repair/]] as const) {
    const states: PanelReadiness[] = [];
    const preparation = new PanelPreparation(async () => Response.json({ state: "reconnect-required", reason, error: "secret-sentinel" }, { status: 503 }), state => states.push(state));
    await assert.rejects(preparation.ensure(), pattern);
    assert.doesNotMatch(states.at(-1)!.message, /secret-sentinel/);
    preparation.invalidate();
  }
});
void test("panel opens and commands share one preparation; cached prerequisite check emits no duplicate request", async () => {
  let complete!: (value: Response) => void;
  let calls = 0;
  const states: PanelReadiness[] = [];
  const preparation = new PanelPreparation(() => { calls++; return new Promise(resolve => { complete = resolve; }); }, state => states.push(state));
  const opening = preparation.ensure();
  assert.equal(preparation.ensure(), opening);
  complete(ready());
  await opening;
  await preparation.ensure();
  assert.equal(calls, 1);
  assert.deepEqual(states.map(state => state.state), ["preparing", "ready"]);
  assert.match(states[1]!.message, /Player perception/);
  assert.match(states[1]!.message, /Private campaign-file protection and player\/TV acceptance remain required/);
  preparation.invalidate();
});
void test("disconnect/close fences delayed response; reconnect starts fresh prerequisite check", async () => {
  let complete!: (value: Response) => void;
  const states: PanelReadiness[] = [];
  let calls = 0;
  const preparation = new PanelPreparation(() => { calls++; return calls === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(ready()); }, state => states.push(state));
  const opening = preparation.ensure();
  preparation.invalidate("Disconnected.");
  complete(ready());
  await assert.rejects(opening, /cancelled/);
  assert.equal(states.at(-1)?.message, "Disconnected.");
  await preparation.ensure();
  assert.equal(states.at(-1)?.state, "ready");
  preparation.invalidate();
});
void test("invalid/expired/unavailable readiness fails closed with bounded retry backoff", async () => {
  for (const response of [Response.json({state:"ready",validUntil:"invalid"}),Response.json({state:"ready",validUntil:new Date(0).toISOString()}),Response.json({state:"reconnect-required",retryAfterMs:5000},{status:503}),Response.json({}, {status:401})]) {
    let calls = 0;
    const states: PanelReadiness[] = [];
    const preparation = new PanelPreparation(async () => { calls++; return response; }, state => states.push(state));
    await assert.rejects(preparation.ensure(), /Reconnect required/);
    await assert.rejects(preparation.ensure(), /wait briefly/);
    assert.equal(calls, 1);
    assert.equal(states.at(-1)?.state, "reconnect-required");
    preparation.invalidate();
  }
});
