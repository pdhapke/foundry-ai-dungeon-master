import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const prepared = JSON.parse(readFileSync('docs/phase5-prepared-build.json', 'utf8'));
const [mcp, ai, python] = await Promise.all([3939, 3940, 3941].map(async port => {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) throw new Error(`Health ${port}: ${response.status}`);
  return response.json();
}));
const codeDigest = createHash('sha256').update(readFileSync('chatkit-server/app.py')).digest('hex');
const checks = {
  aiManifest: ai.build?.manifestDigest === prepared.ai.manifestDigest,
  mcpManifest: mcp.build?.manifestDigest === prepared.mcp.manifestDigest,
  pythonCode: python.codeDigest === codeDigest,
  normalRequestLimit15: python.maxModelTurns === 15,
};
const record = {
  capturedAt: new Date().toISOString(), checks,
  loaded: { ai: ai.build, mcp: mcp.build,
    python: { codeDigest: python.codeDigest, promptVersion: python.promptVersion,
      promptDigest: python.promptDigest, maxModelTurns: python.maxModelTurns } },
  pass: Object.values(checks).every(Boolean),
  scope: 'Server startup identities only; verify browser/native receiver separately',
  inferenceRequests: 0,
};
writeFileSync('docs/phase5-loaded-verification.json', JSON.stringify(record, null, 2), 'utf8');
console.log(JSON.stringify({ checks, pass: record.pass }));
if (!record.pass) process.exitCode = 1;
