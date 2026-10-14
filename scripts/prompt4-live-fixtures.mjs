// Prepared helper. Every invocation performs exactly one explicitly selected phase.
// No model calls, settings changes, service lifecycle calls, or automatic retries.
import { open, call } from '../docs/phase4-live-client.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';

const mode = process.argv[2];
const allowed = ['capture', 'setup', 'view', 'secret', 'second', 'read', 'restore', 'verify'];
if (!allowed.includes(mode)) throw Error(`Choose ${allowed.join('/')}`);
const userId = 'edtBL96Yu3058QAT';
const file = 'docs/prompt4-live-fixture-ledger.json';
let ledger = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(ledger, null, 2)); renameSync(`${file}.tmp`, file); };
const corr = () => `prompt4-${randomUUID()}`;
const freshId = () => randomBytes(8).toString('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const docId = doc => doc?._id ?? doc?.id;
const client = await open();
async function clients() { return (await call(client, 'foundry_get_capability_report')).clients; }
async function guard({ playerRequired = true } = {}) {
  if (!ledger || ledger.restored) throw Error('Fresh unfinished capture required');
  if ((await call(client, 'foundry_get_status')).worldId !== ledger.worldId) throw Error('World changed; stop');
  if ((await call(client, 'foundry_get_setting', { namespace: 'foundry-ai-dungeon-master', key: 'automaticEventsEnabled' })).value !== false) throw Error('Automatic events must already be false; no toggle');
  const live = await clients();
  if (!live.some(c => c.clientId === ledger.gm.clientId && c.userId === ledger.gm.userId && c.isGM && c.lane === 'gm' && c.optedIn)) throw Error('Exact captured GM missing; no substitution');
  if (playerRequired && !live.some(c => c.clientId === ledger.player.clientId && c.userId === userId && !c.isGM && c.lane === 'player' && c.optedIn && c.connectedAt === ledger.player.connectedAt)) throw Error('Exact player connection/consent changed; stop');
  if (ledger.operations.some(o => o.state === 'uncertain' || o.state === 'pending')) throw Error('Uncertain operation requires independent reconciliation; no replay');
}
async function owned(kind) {
  const id = ledger.ids[`${kind}Id`];
  const list = await call(client, kind === 'scene' ? 'foundry_list_scenes' : 'foundry_list_actors');
  if (!Array.isArray(list)) throw Error('Collection identity unavailable');
  if (!list.some(doc => docId(doc) === id)) return null;
  const doc = await call(client, `foundry_get_${kind}`, { id });
  if (doc.name !== ledger.names[kind]) throw Error(`Exact ${kind} fixture identity changed; refuse mutation`);
  return doc;
}
async function validate(documentType, data, validationMode = 'create', embedded = false) {
  const result = await call(client, 'foundry_validate_document_data', {
    documentType, mode: validationMode, data,
    ...(embedded ? { parentDocumentType: 'Scene', parentDocumentId: ledger.ids.sceneId } : {}),
    expectedFoundryVersion: ledger.gm.foundryVersion,
    expectedSystemId: ledger.gm.systemId, expectedSystemVersion: ledger.gm.systemVersion,
  });
  ledger.validations.push({ documentType, mode: validationMode, result }); save();
  if (result.results?.length !== 1 || !result.results[0].valid || result.results[0].warnings?.length) throw Error('Native validation or portable warning gate failed; no mutation');
}
async function mutate(label, name, args, { playerRequired = true } = {}) {
  await guard({ playerRequired });
  const row = { label, name, args, state: 'pending', at: new Date().toISOString() };
  ledger.operations.push(row); save();
  try {
    const value = await call(client, name, args);
    if (name.startsWith('foundry_create_') && !docId(value)) throw Error('Created identity missing');
    row.receipt = value; row.state = 'confirmed'; save(); return value;
  } catch {
    row.state = 'uncertain'; save(); throw Error(`${label}: uncertain outcome; stop and inspect predetermined IDs, do not retry`);
  }
}
async function readiness(target) {
  const result = await call(client, 'foundry_get_client_readiness', { clientId: target.clientId, correlationId: corr() });
  if (result.executingClientId !== target.clientId || result.clientUserId !== target.userId || !result.viewport || !result.activeSceneId) throw Error('Exact client scene/viewport identity missing');
  return result;
}
async function viewMatches(target, before) {
  const after = await readiness(target);
  return { clientId: target.clientId, matches: after.activeSceneId === before.activeSceneId && Math.abs(after.viewport.x - before.viewport.x) <= 1 && Math.abs(after.viewport.y - before.viewport.y) <= 1 && Math.abs(after.viewport.scale - before.viewport.scale) <= 0.001 };
}
async function verification() {
  if ((await call(client, 'foundry_get_status')).worldId !== ledger.worldId) throw Error('World changed; restoration cannot be verified');
  const sceneExists = !!(await owned('scene')), actorExists = !!(await owned('actor'));
  const views = [];
    for (const entry of [...ledger.targetViews, ...(ledger.unrelatedViews ?? [])]) views.push(await viewMatches(entry.client, entry.readiness));
  const originalScenes = [];
  for (const before of ledger.originalScenes) originalScenes.push({ id: docId(before), unchanged: same(before, await call(client, 'foundry_get_scene', { id: docId(before) })) });
  const originalActors = [];
  for (const before of ledger.originalActors) originalActors.push({ id: docId(before), unchanged: same(before, await call(client, 'foundry_get_actor', { id: docId(before) })) });
  const fog = [];
  for (const before of ledger.originalFog) {
    const after = await call(client, 'foundry_get_scene_fog', { sceneId: before.sceneId, userId: before.userId });
    fog.push({ sceneId: before.sceneId, userId: before.userId, unchanged: before.exists === after.exists && same(before.state, after.state) });
  }
  const live = await clients();
  const consent = ledger.consent.map(before => ({ clientId: before.clientId, unchanged: live.some(c => c.clientId === before.clientId && c.userId === before.userId && c.lane === before.lane && c.isGM === before.isGM && c.optedIn === before.optedIn) }));
  const result = { fixtureSceneDeleted: !sceneExists, fixtureActorDeleted: !actorExists, views, originalScenes, originalActors, fog, consent,
    activeSceneUnchanged: ledger.activeSceneId === docId((await call(client, 'foundry_list_scenes')).find(s => s.active)),
    pauseUnchanged: same(ledger.pause, await call(client, 'foundry_get_game_paused')),
    combatUnchanged: same(ledger.combats, await call(client, 'foundry_list_combats')),
    automaticEventsUnchanged: same(ledger.automaticEvents, await call(client, 'foundry_get_setting', { namespace: 'foundry-ai-dungeon-master', key: 'automaticEventsEnabled' })),
    fixtureFogVerifiedBeforeDeletion: ledger.fixtureFogChecks?.every(v => v.absent) === true,
  };
  ledger.restoreVerification = result;
  ledger.restored = Object.values(result).filter(v => typeof v === 'boolean').every(Boolean) && [views, originalScenes, originalActors, fog, consent].every(rows => rows.every(row => row.matches ?? row.unchanged));
  save(); return result;
}
try {
  if (mode === 'capture') {
    if (ledger && !ledger.restored) throw Error('Unfinished ledger preserved; no capture overwrite');
    const live = await clients();
    const players = live.filter(c => c.userId === userId && c.lane === 'player' && !c.isGM && c.optedIn);
    const gms = live.filter(c => c.isGM && c.lane === 'gm' && c.optedIn);
    if (players.length !== 1 || gms.length !== 1) throw Error('Require exact one opted-in intended player and one opted-in GM; choose explicitly before proceeding');
    const runId = randomUUID();
    ledger = { version: 1, capturedAt: new Date().toISOString(), runId, worldId: (await call(client, 'foundry_get_status')).worldId, userId,
      player: players[0], gm: gms[0], consent: live.map(({ clientId, userId, lane, isGM, optedIn, connectedAt }) => ({ clientId, userId, lane, isGM, optedIn, connectedAt })),
      names: { scene: `Prompt4 perception ${runId}`, actor: `Prompt4 observer ${runId}` },
      ids: Object.fromEntries(['scene', 'actor', 'primary', 'target', 'hidden', 'door', 'second'].map(key => [`${key}Id`, freshId()])),
      targetViews: [], unrelatedViews: [], originalScenes: [], originalActors: [], originalFog: [], validations: [], operations: [], restored: false,
      activeSceneId: docId((await call(client, 'foundry_list_scenes')).find(s => s.active)),
      pause: await call(client, 'foundry_get_game_paused'), combats: await call(client, 'foundry_list_combats'),
      automaticEvents: await call(client, 'foundry_get_setting', { namespace: 'foundry-ai-dungeon-master', key: 'automaticEventsEnabled' }),
    };
    if (typeof ledger.worldId !== 'string' || ledger.automaticEvents.value !== false) throw Error('Missing world or automatic events enabled; no mutation');
    for (const receiver of [ledger.gm, ledger.player]) ledger.targetViews.push({ client: receiver, readiness: await readiness(receiver) });
    for (const receiver of live.filter(c => c.optedIn && c.clientId !== ledger.gm.clientId && c.clientId !== ledger.player.clientId)) ledger.unrelatedViews.push({ client: receiver, readiness: await readiness(receiver) });
    for (const sid of new Set(ledger.targetViews.map(v => v.readiness.activeSceneId))) {
      const scene = await call(client, 'foundry_get_scene', { id: sid }); ledger.originalScenes.push(scene);
      for (const actorId of new Set((scene.tokens ?? []).map(t => t.actorId).filter(Boolean))) if (!ledger.originalActors.some(a => docId(a) === actorId)) ledger.originalActors.push(await call(client, 'foundry_get_actor', { id: actorId }));
    }
    for (const { client: receiver, readiness: view } of ledger.targetViews) ledger.originalFog.push(await call(client, 'foundry_get_scene_fog', { sceneId: view.activeSceneId, userId: receiver.userId }));
    save(); console.log('Captured originals, no mutation. Root must verify loaded server/client build before setup.');
  } else if (mode === 'setup') {
    await guard(); if (ledger.operations.length) throw Error('Repeated setup prohibited');
    const actorData = { _id: ledger.ids.actorId, name: ledger.names.actor, type: 'npc', ownership: { default: 0, [userId]: 3 }, prototypeToken: { sight: { enabled: true, range: 60, visionMode: 'basic' } } };
    await validate('Actor', actorData);
    ledger.ids.actorId = docId(await mutate('create owned observer', 'foundry_create_actor', { data: actorData })); save();
    const sceneData = { _id: ledger.ids.sceneId, name: ledger.names.scene, ownership: { default: 0, [userId]: 2 }, width: 1200, height: 800, padding: 0, grid: { type: 1, size: 100, distance: 5, units: 'ft' }, tokenVision: true, fog: { mode: 1 }, environment: { darknessLevel: 0, globalLight: { enabled: true } } };
    await validate('Scene', sceneData);
    ledger.ids.sceneId = docId(await mutate('create calibrated scene', 'foundry_create_scene', { data: sceneData })); save();
    const wallData = { _id: ledger.ids.doorId, c: [600, 0, 600, 800], move: 20, sight: 20, light: 20, sound: 20, door: 1, ds: 0 };
    await validate('Wall', wallData, 'create', true);
    ledger.ids.doorId = docId(await mutate('create closed door barrier', 'foundry_create_scene_wall', { sceneId: ledger.ids.sceneId, data: wallData })); save();
    for (const [key, x, y, hidden, owner] of [['primary', 200, 350, false, true], ['target', 850, 350, false, false], ['hidden', 300, 550, true, false]]) {
      const data = { _id: ledger.ids[`${key}Id`], name: `Prompt4 ${key}`, actorId: owner ? ledger.ids.actorId : null, actorLink: owner, delta: null, x, y, width: 1, height: 1, elevation: 0, hidden, texture: { src: 'icons/svg/mystery-man.svg' }, sight: { enabled: owner, range: 60, visionMode: 'basic' }, detectionModes: owner ? [{ id: 'basicSight', enabled: true, range: 60 }] : [] };
      await validate('Token', data, 'create', true);
      ledger.ids[`${key}Id`] = docId(await mutate(`create ${key}`, 'foundry_create_scene_token', { sceneId: ledger.ids.sceneId, data })); save();
    }
    ledger.setupComplete = true; save(); console.log(JSON.stringify({ ids: ledger.ids, sceneNotActivated: true }));
  } else if (mode === 'view') {
    await guard(); if (!ledger.setupComplete || !(await owned('scene'))) throw Error('Fixture missing');
    for (const target of [ledger.gm, ledger.player]) await mutate('target fixture viewport', 'foundry_apply_client_viewport', { clientId: target.clientId, sceneId: ledger.ids.sceneId, viewport: { x: 600, y: 400, scale: 1 }, correlationId: corr() });
    ledger.fixtureViews = []; for (const target of [ledger.gm, ledger.player]) ledger.fixtureViews.push(await readiness(target)); save();
  } else if (mode === 'secret') {
    await guard(); if (!(await owned('scene')) || ledger.secretApplied) throw Error('Fixture missing or secret case already applied');
    const wall = await call(client, 'foundry_get_scene_wall', { sceneId: ledger.ids.sceneId, placeableId: ledger.ids.doorId });
    await validate('Wall', { c: wall.c, door: 2, ds: 0 }, 'update', true);
    await mutate('secret door case', 'foundry_update_scene_wall', { sceneId: ledger.ids.sceneId, placeableId: ledger.ids.doorId, changes: { door: 2, ds: 0 } }); ledger.secretApplied = true; save();
  } else if (mode === 'second') {
    await guard(); if (!(await owned('scene')) || !(await owned('actor')) || ledger.secondApplied) throw Error('Fixture missing or second case already applied');
    const data = { _id: ledger.ids.secondId, name: 'Prompt4 second owned source', actorId: ledger.ids.actorId, actorLink: true, delta: null, x: 850, y: 350, width: 1, height: 1, elevation: 0, hidden: false, texture: { src: 'icons/svg/mystery-man.svg' }, sight: { enabled: true, range: 60, visionMode: 'basic' }, detectionModes: [{ id: 'basicSight', enabled: true, range: 60 }] };
    await validate('Token', data, 'create', true);
    ledger.ids.secondId = docId(await mutate('second intended-player owned source', 'foundry_create_scene_token', { sceneId: ledger.ids.sceneId, data })); ledger.secondApplied = true; save();
  } else if (mode === 'read') {
    await guard(); if (!ledger.setupComplete || !(await owned('scene'))) throw Error('Fixture missing');
    const observations = [];
    for (const tokenId of [ledger.ids.primaryId, ...(ledger.secondApplied ? [ledger.ids.secondId] : [])]) observations.push(await call(client, 'foundry_get_token_visibility', { sceneId: ledger.ids.sceneId, effectiveUserId: userId, clientId: ledger.player.clientId, tokenId, queryPoints: [{ id: 'near-primary', x: 250, y: 400, elevation: 0 }, { id: 'beyond-door', x: 900, y: 400, elevation: 0 }] }));
    await guard(); const path = `docs/prompt4-native-observations-${Date.now()}.json`; writeFileSync(path, JSON.stringify({ worldId: ledger.worldId, clientId: ledger.player.clientId, userId, observations, evidenceScope: 'native MCP only; not authenticated AI adapter or browser observation', inferenceCalls: 0 }, null, 2)); console.log(path);
  } else if (mode === 'restore') {
    await guard({ playerRequired: false });
    for (const entry of ledger.targetViews) {
      await mutate('restore original viewport', 'foundry_apply_client_viewport', { clientId: entry.client.clientId, sceneId: entry.readiness.activeSceneId, viewport: entry.readiness.viewport, correlationId: corr() }, { playerRequired: false });
      if (!(await viewMatches(entry.client, entry.readiness)).matches) throw Error('Viewport readback failed; preserve fixture for recovery');
    }
    const scene = await owned('scene'); ledger.fixtureFogChecks = [];
    if (scene) for (const fogUserId of new Set(ledger.targetViews.map(v => v.client.userId))) {
      const fog = await call(client, 'foundry_get_scene_fog', { sceneId: ledger.ids.sceneId, userId: fogUserId });
      if (fog.exists) await mutate('delete fixture fog while scene exists', 'foundry_update_scene_fog', { sceneId: ledger.ids.sceneId, userId: fogUserId, mode: 'replace', state: {}, removeDocument: true, expectedRevision: fog.revision, idempotencyKey: corr() }, { playerRequired: false });
      const after = await call(client, 'foundry_get_scene_fog', { sceneId: ledger.ids.sceneId, userId: fogUserId });
      ledger.fixtureFogChecks.push({ sceneId: ledger.ids.sceneId, userId: fogUserId, checkedAt: new Date().toISOString(), sceneStillExists: true, absent: after.exists === false }); save();
      if (after.exists) throw Error('Fixture fog remains; stop before scene deletion');
    }
    if (scene) await mutate('delete exact test-owned scene', 'foundry_delete_scene', { id: ledger.ids.sceneId }, { playerRequired: false });
    if (await owned('actor')) await mutate('delete exact test-owned actor', 'foundry_delete_actor', { id: ledger.ids.actorId }, { playerRequired: false });
    console.log(JSON.stringify(await verification()));
  } else if (mode === 'verify') {
    if (!ledger) throw Error('Ledger missing');
    console.log(JSON.stringify(await verification()));
  }
} finally { await client.close(); }

