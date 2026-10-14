import { open, call } from './phase4-live-client.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const proposal = JSON.parse(readFileSync('docs/phase4-reconciliation-proposal.json', 'utf8'));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const client = await open();
try {
  const status = await call(client, 'foundry_get_status');
  if (status.worldId !== proposal.worldId || status.userId !== proposal.userId) throw Error('Exact world/GM mismatch');
  const before = await call(client, 'foundry_get_journal_entry', { id: proposal.journalId });
  if (hash(before) !== proposal.expectedJournalHash || hash(before.flags) !== proposal.expectedJournalFlagsHash)
    throw Error('Journal changed since reviewed proposal; no write');
  if (before.ownership?.default !== 0) throw Error('Private journal ownership mismatch');
  const flags = before.flags['foundry-local-api'];
  const pending = ['attackLedger', 'attackSequenceLedger'].flatMap(flag => Object.entries(flags[flag] ?? {})
    .filter(([, entry]) => entry.pending).map(([key]) => `${flag}:${key}`));
  if (pending.length !== 2 || !proposal.entries.every(entry => pending.includes(`${entry.flag}:${entry.key}`)))
    throw Error('Unexpected pending workflow; no write');
  const expected = structuredClone(before.flags);
  const changes = {};
  const acknowledgedAt = new Date().toISOString();
  for (const entry of proposal.entries) {
    const original = flags[entry.flag][entry.key];
    if (hash(original) !== entry.expectedHash || original.pending !== true || original.result?.outcome !== 'uncertain')
      throw Error('Exact uncertain entry mismatch; no write');
    const audit = { ...proposal.proposedChange.terminalAudit,
      approval: 'Explicit user approval in current task', acknowledgedAt };
    expected['foundry-local-api'][entry.flag][entry.key].pending = false;
    expected['foundry-local-api'][entry.flag][entry.key].terminalAudit = audit;
    changes[`flags.foundry-local-api.${entry.flag}.${entry.key}.pending`] = false;
    changes[`flags.foundry-local-api.${entry.flag}.${entry.key}.terminalAudit`] = audit;
  }
  writeFileSync('docs/phase4-reconciliation-before.json', JSON.stringify(before, null, 2), 'utf8');
  // No retry after dispatch: lost acknowledgement requires independent readback.
  await call(client, 'foundry_update_journal_entry', { id: proposal.journalId, changes });
  const after = await call(client, 'foundry_get_journal_entry', { id: proposal.journalId });
  const verified = hash(after.flags) === hash(expected);
  writeFileSync('docs/phase4-reconciliation-result.json', JSON.stringify({
    acknowledgedAt, journalId: proposal.journalId, verified,
    beforeFlagsHash: hash(before.flags), afterFlagsHash: hash(after.flags), expectedFlagsHash: hash(expected),
    changes, after, mechanicsRetried: false, memoryFencesCleared: false,
  }, null, 2), 'utf8');
  if (!verified) throw Error('Reconciliation readback mismatch; stop without retry');
  console.log('Verified only two pending booleans and terminal audit fields changed; no mechanics retried.');
} finally { await client.close(); }
