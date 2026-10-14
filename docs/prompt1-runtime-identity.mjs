import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read-only health and static-route probes; never request credentials or emit bodies.
const report = { capturedAt: new Date().toISOString(), inferenceRequests: 0,
  scope: 'Loaded process identity versus current disk; no restart, reload, enrollment or gameplay mutation.', services: {}, staticPrivacy: [] };
for (const [name, port, root] of [['ai',3940,process.cwd()], ['mcp',3939,resolve('../foundry-local-api')], ['python',3941,process.cwd()]]) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    const artifacts = Object.entries(health.build?.artifactHashes ?? {}).map(([path, loadedHash]) => {
      let diskHash = null;
      try { diskHash = createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex'); } catch {}
      return { path, loadedHash, diskHash, matches: loadedHash === diskHash };
    });
    report.services[name] = { http: response.status, status: health.status,
      startedAt: health.build?.startedAt, manifestDigest: health.build?.manifestDigest, artifacts,
      maxModelTurns: health.maxModelTurns, codeDigest: health.codeDigest,
      ...(name === 'python' ? { diskCodeDigest: createHash('sha256').update(readFileSync('chatkit-server/app.py')).digest('hex') } : {}) };
  } catch (error) { report.services[name] = { error: error.message }; }
}
for (const path of ['/modules/foundry-ai-dungeon-master/.runtime/ai-dungeon-master/chatkit.sqlite', '/modules/foundry-ai-dungeon-master/.runtime/chatkit.sqlite', '/worlds/izzy-campaign/data/campaign/secrets-tracker.md']) {
  try {
    const response = await fetch(`http://127.0.0.1:30000${path}`, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(5000) });
    const reader = response.body?.getReader();
    const first = reader ? await reader.read() : {};
    await reader?.cancel();
    report.staticPrivacy.push({ path, status: response.status, contentType: response.headers.get('content-type'), receivedBody: Boolean(first.value), bodyNotPrinted: true });
  } catch (error) { report.staticPrivacy.push({ path, error: error.message }); }
}
writeFileSync('docs/prompt1-runtime-identity.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({services: Object.fromEntries(Object.entries(report.services).map(([name,value]) => [name, { status: value.status, startedAt: value.startedAt, maxModelTurns: value.maxModelTurns, changedArtifacts: value.artifacts?.filter(a=>!a.matches).map(a=>a.path), pythonSourceMatches: value.codeDigest ? value.codeDigest === value.diskCodeDigest : undefined }])), staticPrivacy: report.staticPrivacy}));
