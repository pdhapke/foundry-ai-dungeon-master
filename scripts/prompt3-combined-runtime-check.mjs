import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureBuildIdentity } from '../server/dist/build-identity.js';
import { startupBuildIdentity } from '../../foundry-local-api/server/dist/build-identity.js';

// Read-only service/disk identity and anonymous static probes. No credentials,
// model requests, campaign reads, publication or gameplay commands.
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(root, '../../../../.runtime/foundry-ai-dungeon-master/prompt3-combined-evidence');
const hash = path => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };
const report = { capturedAt: new Date().toISOString(), scope: 'Service liveness and startup bytes only; not GM/campaign/browser readiness', inferenceRequests: 0, services: {}, staticPrivacy: [] };
for (const [name, port, base, required] of [
  ['ai',3940,root,captureBuildIdentity(root).artifactHashes],
  ['mcp',3939,resolve(root,'../foundry-local-api'),startupBuildIdentity.artifactHashes],
  ['python',3941,root,{}],
]) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    const loaded = health.build?.artifactHashes ?? {};
    const artifacts = Object.entries(loaded).map(([path, loadedHash]) => ({ path, loadedHash, diskHash: hash(resolve(base,path)), matches: loadedHash !== null && loadedHash === hash(resolve(base,path)) }));
    report.services[name] = { http: response.status, serviceStatus: health.status, startedAt: health.build?.startedAt,
      artifacts, requiredArtifacts: required, missingStartupArtifacts: Object.keys(required).filter(path => !Object.hasOwn(loaded,path)),
      requiredDiskArtifactsAbsent: Object.entries(required).filter(([,value])=>value===null).map(([path])=>path),
      chatkitRequests: health.chatkit?.requests, promptVersion: health.promptVersion, maxModelTurns: health.maxModelTurns,
      ...(name === 'python' ? { loadedCodeDigest: health.codeDigest, diskCodeDigest: hash(resolve(root,'chatkit-server/app.py')), codeMatches: health.codeDigest === hash(resolve(root,'chatkit-server/app.py')), loadedPromptDigest: health.promptDigest } : {}) };
  } catch (error) { report.services[name] = { error: error.message }; }
}
for (const path of ['/worlds/izzy-campaign/data/campaign/secrets-tracker.md', '/worlds/izzy-campaign/data/campaign/overview.md', '/modules/foundry-ai-dungeon-master/.runtime/chatkit.sqlite', '/modules/foundry-ai-dungeon-master/.runtime/ai-dungeon-master/chatkit.sqlite']) {
  try {
    const response = await fetch(`http://127.0.0.1:30000${path}`, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(5000) });
    report.staticPrivacy.push({ path, status: response.status, contentType: response.headers.get('content-type'), bodyNotReadOrPrinted: true });
    await response.body?.cancel();
  } catch (error) { report.staticPrivacy.push({ path, error: error.message }); }
}
const campaign = resolve(root,'../../../../.runtime/foundry-ai-dungeon-master/campaign-worlds/izzy-campaign/data/campaign');
report.campaign = { privateRootExists: existsSync(campaign), overviewExists: existsSync(resolve(campaign,'overview.md')), indexExists: existsSync(resolve(campaign,'index.md')), contentNotRead: true };
writeFileSync(resolve(runtime,'runtime-identity.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({ services: Object.fromEntries(Object.entries(report.services).map(([name,value])=>[name,{serviceStatus:value.serviceStatus,startedAt:value.startedAt,loadedArtifacts:value.artifacts?.length,matches:value.artifacts?.filter(a=>a.matches).length,requiredArtifacts:Object.keys(value.requiredArtifacts??{}).length,missingStartupArtifacts:value.missingStartupArtifacts?.length,requiredDiskArtifactsAbsent:value.requiredDiskArtifactsAbsent,codeMatches:value.codeMatches,requests:value.chatkitRequests,promptVersion:value.promptVersion,maxModelTurns:value.maxModelTurns}])), staticPrivacy:report.staticPrivacy,campaign:report.campaign }));
