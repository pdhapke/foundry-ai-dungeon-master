import { writeFileSync } from 'node:fs';
import { captureBuildIdentity } from '../server/dist/build-identity.js';
import { startupBuildIdentity } from '../../foundry-local-api/server/dist/build-identity.js';

const ai = captureBuildIdentity(process.cwd());
const mcp = { ...startupBuildIdentity };
for (const identity of [ai, mcp]) {
  identity.capturedAt = identity.startedAt;
  delete identity.startedAt;
}
writeFileSync('docs/phase4-prepared-build.json', JSON.stringify({
  preparedAt: new Date().toISOString(),
  status: 'disk artifacts only; not loaded runtime', ai, mcp,
}, null, 2), 'utf8');
