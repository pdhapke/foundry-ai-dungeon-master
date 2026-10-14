import test from 'node:test';
import assert from 'node:assert/strict';
import { planBattlemap } from './battlemap-plan.js';
const hash = 'a'.repeat(64);
const fixture = () => ({ worldId: 'mcp-test', name: 'Forest — TV calibration fixture', assetRef: `ai-dm-prepared-maps/mcp-test/${hash}.png`, sourceHash: hash,
  imageWidth: 1254, imageHeight: 1254, displayWidthMm: 955,
  display: { clientId: 'tv-client', userName: 'TV', role: 2, cssWidth: 1920, cssHeight: 1080, devicePixelRatio: 1, sceneReady: true } });
test('one inch uses CSS width and preserves source geometry in a native v14 level', () => {
  const plan = planBattlemap(fixture());
  assert.equal(plan.scene.width, 3760); assert.equal(plan.scene.height, 2115);
  assert.equal(plan.viewport.scale * 100, 1920 * 25.4 / 955);
  assert.equal(plan.scene.levels[0]!.textures.fit, 'contain');
  assert.equal(plan.scene.active, false); assert.equal(plan.physicalAcceptance, false);
  assert.equal(plan.providerRequests, 0);
  assert.equal(plan.viewport.scale, planBattlemap({ ...fixture(), display: { ...fixture().display, devicePixelRatio: 2 } }).viewport.scale);
});
test('campaign, stale readiness, wrong role, missing TV, and mismatched asset fail closed', () => {
  for (const input of [{ ...fixture(), worldId: 'izzy-campaign' }, { ...fixture(), display: undefined },
    { ...fixture(), display: { ...fixture().display, role: 3 } },
    { ...fixture(), display: { ...fixture().display, sceneReady: false } },
    { ...fixture(), sourceHash: 'b'.repeat(64) }]) assert.throws(() => planBattlemap(input));
});
