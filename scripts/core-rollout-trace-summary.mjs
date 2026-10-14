import {readFileSync,writeFileSync} from 'node:fs';
const path=new URL('../.runtime/core-acceptance-stdout.log',import.meta.url);
const events=readFileSync(path,'utf8').split(/\r?\n/).flatMap(line=>{try{const e=JSON.parse(line);return ['pause-timing','core-timing'].includes(e.type)?[e]:[];}catch{return[];}});
const groups=new Map();for(const e of events){if(e.traceId){if(!groups.has(e.traceId))groups.set(e.traceId,[]);groups.get(e.traceId).push(e);}}
const runs=[...groups].flatMap(([traceId,es])=>{const model=es.filter(e=>e.stage==='model-request');if(!model.length)return[];const arrival=es.find(e=>e.stage==='request-arrival');const tools=es.filter(e=>e.stage==='tool-start');const result=es.find(e=>e.stage==='confirmed-action-result'||e.stage==='core-action-result');const final=es.find(e=>e.stage==='final-response-finished');return[{traceId,arrivalAtMs:arrival?.atMs,queueWaitMs:es.find(e=>e.stage==='queue-entered')?.queueWaitMs,contextMs:es.find(e=>e.stage==='context-prepared')?.durationMs,model:model[0].model,reasoning:model[0].reasoning,modelRequests:model.length,tools:tools.map(t=>t.tool),action:result??null,finalMs:final?.elapsedMs,complete:!!final}];});
writeFileSync(new URL('../docs/core-rollout-evidence/live-traces.json',import.meta.url),JSON.stringify({capturedAt:new Date().toISOString(),events,runs},null,2));
console.log(JSON.stringify(runs));
