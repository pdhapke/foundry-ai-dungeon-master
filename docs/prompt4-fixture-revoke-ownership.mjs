// Prepared fixture-only helper. No retries, service operations or model calls.
import { open, call } from './phase4-live-client.mjs';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = 'docs/prompt4-live-fixture-ledger.json';
const ledger = JSON.parse(readFileSync(file, 'utf8'));
const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(ledger, null, 2)); renameSync(`${file}.tmp`, file); };
const id = value => value?._id ?? value?.id;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = 'revoke fixture ownership';
const created = ledger.operations?.find(row => row.label === 'create owned observer' && row.state === 'confirmed');
if (!ledger.setupComplete || ledger.restored || !created || id(created.receipt) !== ledger.ids?.actorId || created.receipt?.name !== ledger.names?.actor || !ledger.names.actor.includes(ledger.runId)) throw Error('Exact unfinished fixture creation receipt required');
if (ledger.operations.some(row => ['pending', 'uncertain'].includes(row.state) || row.label === label)) throw Error('Pending, uncertain or prior ownership operation requires reconciliation; no replay');
const client = await open();
async function guard() {
  if ((await call(client, 'foundry_get_status')).worldId !== ledger.worldId) throw Error('World changed; no ownership mutation');
  if ((await call(client, 'foundry_get_setting', { namespace: 'foundry-ai-dungeon-master', key: 'automaticEventsEnabled' })).value !== false) throw Error('Automatic events must already be disabled');
  const clients = (await call(client, 'foundry_get_capability_report')).clients;
  for (const [target, lane, isGM] of [[ledger.gm, 'gm', true], [ledger.player, 'player', false]]) {
    if (!clients?.some(value => value.clientId === target.clientId && value.userId === target.userId && value.lane === lane && value.isGM === isGM && value.optedIn === true && value.connectedAt === target.connectedAt && value.foundryVersion === target.foundryVersion && value.systemId === target.systemId && value.systemVersion === target.systemVersion)) throw Error('Exact captured client generation/consent/build context changed');
  }
  if (ledger.player.userId !== ledger.userId) throw Error('Fixture selected player identity changed');
}
async function actor() {
  const value = await call(client, 'foundry_get_actor', { id: ledger.ids.actorId });
  if (id(value) !== ledger.ids.actorId || value.name !== ledger.names.actor || value.type !== created.receipt.type || value._stats?.createdTime !== created.receipt._stats?.createdTime || !value.ownership || typeof value.ownership !== 'object' || Array.isArray(value.ownership)) throw Error('Exact current fixture Actor identity unavailable');
  return value;
}
try {
  await guard();
  const before = await actor();
  if (before.ownership[ledger.userId] !== 3 || before.ownership.default !== 0) throw Error('Expected fixture OWNER permission changed; stop');
  const ownership = { ...before.ownership, default: 0, [ledger.userId]: 0 };
  // Native joint validation needs the exact Actor subtype/name identity; never a typeless synthetic Actor.
  const candidate = { _id: ledger.ids.actorId, name: before.name, type: before.type, ownership };
  const validation = await call(client, 'foundry_validate_document_data', {
    documentType: 'Actor', subtype: before.type, mode: 'update', data: candidate,
    expectedFoundryVersion: ledger.gm.foundryVersion,
    expectedSystemId: ledger.gm.systemId, expectedSystemVersion: ledger.gm.systemVersion,
  });
  ledger.validations ??= [];
  ledger.validations.push({ label, documentType: 'Actor', mode: 'update', beforeDigest: digest(before), candidate, result: validation }); save();
  const result = validation.results?.[0];
  if (validation.complete !== true || validation.persisted !== false || validation.results?.length !== 1 || result?.valid !== true || !Array.isArray(result.warnings) || result.warnings.length || !Array.isArray(result.errors) || result.errors.length || result.persisted !== false || id(result.normalized) !== ledger.ids.actorId || result.normalized?.name !== before.name || result.normalized?.type !== before.type || !result.normalized?.ownership || digest(result.normalized.ownership) !== digest(ownership)) throw Error('Exact native ownership candidate validation blocked; no mutation');
  await guard();
  const fresh = await actor();
  if (digest(fresh) !== digest(before)) throw Error('Fixture Actor changed while native validation pending; stop');
  const row = { label, name: 'foundry_update_actor', state: 'pending', at: new Date().toISOString(), beforeOwnership: before.ownership, beforeDigest: digest(before), args: { id: ledger.ids.actorId, changes: { ownership } } };
  ledger.operations.push(row); save();
  try {
    row.receipt = await call(client, row.name, row.args);
    const confirmed = await actor();
    if (digest(confirmed.ownership) !== digest(ownership)) throw Error('Ownership readback differs');
    row.readback = { actorId: id(confirmed), name: confirmed.name, type: confirmed.type, ownership: confirmed.ownership, modifiedTime: confirmed._stats?.modifiedTime };
    row.state = 'confirmed'; row.confirmedAt = new Date().toISOString();
  } catch {
    row.state = 'uncertain'; row.uncertainAt = new Date().toISOString();
    throw Error('Fixture ownership mutation uncertain; stop and independently reconcile, do not retry');
  } finally { save(); }
  console.log('Exact fixture ownership revocation confirmed by native validation and authoritative readback.');
} finally { await client.close(); }
