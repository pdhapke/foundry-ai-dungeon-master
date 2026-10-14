import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const evidence={capturedAt:new Date().toISOString(),scope:'read-only loaded identity; no provider or gameplay calls',services:{}};
for(const [name,port,root] of [['ai',3940,process.cwd()],['mcp',3939,resolve('../foundry-local-api')],['python',3941,process.cwd()]]) {
 try {
  const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(5000)}),health=await response.json();
  const artifacts=Object.entries(health.build?.artifactHashes??{}).map(([path,loadedHash])=>{
   let diskHash=null;try{diskHash=createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');}catch{}
   return {path,loadedHash,diskHash,matches:loadedHash!==null&&loadedHash===diskHash};
  });
  evidence.services[name]={http:response.status,status:health.status,startedAt:health.build?.startedAt,artifacts,
   chatkit:health.chatkit,maxModelTurns:health.maxModelTurns,promptVersion:health.promptVersion,
   ...(name==='python'?{codeMatches:createHash('sha256').update(readFileSync('chatkit-server/app.py')).digest('hex')===health.codeDigest}:{}),};
 }catch(error){evidence.services[name]={error:error.message};}
}
const output=resolve('../../../../.runtime/foundry-ai-dungeon-master/prompt2-evidence',process.argv[2]??'runtime-identity.json');
if(!/^[-A-Za-z0-9_.]+\.json$/.test(process.argv[2]??'runtime-identity.json'))throw Error('Invalid evidence filename');
writeFileSync(output,JSON.stringify(evidence,null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(evidence.services).map(([name,value])=>[name,{status:value.status,startedAt:value.startedAt,artifactCount:value.artifacts?.length,matches:value.artifacts?.filter(a=>a.matches).length,missing:value.artifacts?.filter(a=>a.loadedHash===null).length,codeMatches:value.codeMatches,requests:value.chatkit?.requests,promptVersion:value.promptVersion,maxModelTurns:value.maxModelTurns}]))));
