// Local operator utility only. Not registered as a model/browser tool.
// All data is retained; this script never relocates/removes source files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planCampaignMigration, copyCampaignMigration } from '../server/src/context/campaign-migration.ts';

const worldId = 'izzy-campaign';
const worldsRoot = resolve('../../worlds');
const options = {
  protectedRoot: resolve('../../../../.runtime/foundry-ai-dungeon-master/campaign-worlds'),
  publicDataRoot: resolve('../..'),
};
const authority = { authorize(id) { if (id !== worldId) throw new Error('Operator scope mismatch'); } };
// The shell operator is authorized by the current task; this is not a fabricated GM session.
mkdirSync(options.protectedRoot, { recursive: true });
const signal = AbortSignal.timeout(60_000);
const manifest = planCampaignMigration(worldsRoot, worldId, options, authority, signal);
const privateManifest = resolve(options.protectedRoot, 'izzy-campaign-source-review.json');
let copied = false;
if (process.argv.includes('--copy')) {
  const expected = process.argv.find(arg => arg.startsWith('--revision='))?.slice('--revision='.length);
  const reviewed = JSON.parse(readFileSync(privateManifest, 'utf8'));
  if (!expected || expected !== manifest.manifestRevision || expected !== reviewed.manifestRevision || reviewed.worldId !== worldId)
    throw new Error('Exact reviewed manifest revision required');
  copyCampaignMigration(worldsRoot, worldId, options, authority, signal, expected);
  copied = true;
} else {
  writeFileSync(privateManifest, JSON.stringify(manifest, null, 2), { flag: 'wx' });
}
const result = { worldId, fileCount: manifest.files.length, totalBytes: manifest.files.reduce((n,f)=>n+f.bytes,0),
  excludedAssetCount: manifest.excludedAssets, manifestRevision: manifest.manifestRevision,
  blockers: manifest.blockers, copied, originalPublicCopiesRemain: true, privacyResolved: false,
  sourceFilesDeleted: 0, inferenceRequests: 0, scope: 'Local copy-only candidate; no runtime reload or live-source change.' };
writeFileSync('docs/prompt1-private-migration-plan.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
