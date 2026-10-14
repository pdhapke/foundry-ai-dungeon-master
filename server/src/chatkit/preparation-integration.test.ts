import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createAiDmApp } from '../app.js';
import { createChatKitGateway } from './gateway.js';
import type { AiDmAuthenticatedIdentity } from '@foundry-ai-dungeon-master/shared';

function fixture(mode: 'gm' | 'player' | 'revoked' | 'anonymous' = 'gm') {
  let calls = 0, checks = 0;
  const app = createAiDmApp({ readiness: () => ({ ready: true, details: {} }), chatkitHandler: createChatKitGateway({
    sidecarUrl: 'http://127.0.0.1:3941', internalSecret: 'fixture', allowedOrigins: ['http://localhost:30000'],
    authenticate: () => { if (mode === 'anonymous') throw Error('denied'); return { worldId: 'world', userId: 'gm', clientId: 'exact-client', isGm: mode !== 'player' } as AiDmAuthenticatedIdentity; },
    authorize: async identity => { checks++; assert.equal(identity.clientId, 'exact-client'); if (mode === 'revoked') throw Error('revoked'); },
    resolveAuthorization: () => { throw Error('Preparation must not resolve provider credentials'); },
    fetch: () => { throw Error('Preparation must not invoke provider'); },
    preparationAction: async (identity, body) => { calls++; assert.equal(identity.worldId, 'world'); assert.deepEqual(body, { operation: 'template', input: { passId: 'inventory' } }); return { modelCalls: 0 }; },
  }) });
  return { app, calls: () => calls, checks: () => checks };
}
test('preparation is current exact-client authenticated and zero provider, rechecks before delivery', async () => {
  const f = fixture(); const response = await request(f.app).post('/chatkit/preparation').send({ operation: 'template', input: { passId: 'inventory' } });
  assert.equal(response.status, 200); assert.equal(response.body.modelCalls, 0); assert.equal(f.calls(), 1); assert.equal(f.checks(), 2);
});
test('preparation rejects player, revoked, anonymous and foreign origin before any operation', async () => {
  for (const [mode, status] of [['player',403],['revoked',403],['anonymous',401]] as const) {
    const f = fixture(mode); assert.equal((await request(f.app).post('/chatkit/preparation').send({})).status,status); assert.equal(f.calls(),0);
  }
  const f = fixture(); assert.equal((await request(f.app).post('/chatkit/preparation').set('Origin','https://foreign.invalid').send({})).status,403); assert.equal(f.calls(),0);
});
