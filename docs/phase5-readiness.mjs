import { open, call } from './phase4-live-client.mjs';
import { writeFileSync } from 'node:fs';
const client = await open();
try {
  const [capabilities, status] = await Promise.all([
    call(client, 'foundry_get_capability_report'), call(client, 'foundry_get_status'),
  ]);
  const record = { capturedAt: new Date().toISOString(), capabilities, status,
    inferenceRequests: 0, fixtureMutations: 0, scope: 'current read-only client readiness' };
  writeFileSync('docs/phase5-client-readiness.json', JSON.stringify(record, null, 2), 'utf8');
  console.log(JSON.stringify(record));
} finally { await client.close(); }
