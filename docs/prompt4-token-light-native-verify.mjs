import {open,call} from './phase4-live-client.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const c=await open(); const records=[];
try {
 const capabilities=await call(c,'foundry_get_capability_report');
 for(const userId of ['edtBL96Yu3058QAT','X7X4KK7zca5U2Ics']) {
  const matches=capabilities.clients.filter(v=>v.userId===userId&&v.optedIn);
  if(matches.length!==1) throw Error(`Exact receiver selection failed for ${userId}: ${matches.length}`);
  const target=matches[0],traceId=randomUUID();
  const raw=await c.callTool({name:'foundry_get_client_readiness',arguments:{clientId:target.clientId,userId,correlationId:randomUUID()},_meta:{'foundry-ai-dungeon-master/trace-id':traceId}});
  if(raw.isError)throw Error('Receiver readiness rejected');
  records.push({target:{clientId:target.clientId,userId,isGM:target.isGM,lane:target.lane,optedIn:target.optedIn},traceId,ack:raw.structuredContent??JSON.parse(raw.content.find(v=>v.type==='text').text)});
 }
 // A final read keeps the bridge session healthy while the bounded async telemetry sink drains.
 await call(c,'foundry_get_capability_report');
 const rows=readFileSync('../foundry-local-api/.runtime/latency-traces.jsonl','utf8').split('\n').filter(Boolean).map(v=>JSON.parse(v));
 const expectedBuild=readFileSync('../foundry-local-api/module/src/latency-build.ts','utf8').match(/"([a-f0-9]{64})"/)[1];
 for(const r of records){r.native=rows.filter(v=>v.traceId===r.traceId&&v.component==='foundry-native');r.loadedBuildMatches=r.native.some(v=>v.instrumentationBuild===expectedBuild);}
 const report={capturedAt:new Date().toISOString(),expectedBuild,receivers:records,gate:records.every(v=>v.loadedBuildMatches)?'PASS':'BLOCKED',scope:'Read-only exact receiver acknowledgement plus native loaded instrumentation marker. Readiness sceneReady reflects last preload bookkeeping, not canvas paint completion.'};
 writeFileSync('docs/prompt4-token-light-native-identity.json',JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report));
}finally{await c.close();}


