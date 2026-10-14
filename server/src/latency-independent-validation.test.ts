import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LatencySink,configureLatencyTrace,withLatencyTrace,latencySpan } from './latency-trace.js';
const id='12345678-1234-1234-1234-123456789abc';
void test('independent concurrent correlations and monotonic durations preserve isolation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'latency-independent-'));try{
 const path=join(dir,'rows.jsonl');const sink=configureLatencyTrace(path);
 const other='22345678-1234-1234-1234-123456789abc';
 await Promise.all([withLatencyTrace(id,()=>latencySpan('one',async()=>{await Promise.resolve();return 1;})),withLatencyTrace(other,()=>latencySpan('two',async()=>2))]);await sink.flush();
 const rows=(await readFile(path,'utf8')).trim().split('\n').map(x=>JSON.parse(x));assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(x=>x.traceId)),new Set([id,other]));assert.ok(rows.every(x=>x.durationMs>=0&&x.elapsedMs>=0));
 }finally{await rm(dir,{recursive:true,force:true});}
});
void test('independent projection strips arbitrary secret fields and bounds queue',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'latency-independent-'));try{const path=join(dir,'rows.jsonl');const sink=new LatencySink(path);const row={schemaVersion:1 as const,traceId:id,component:'unit',stage:'test',elapsedMs:0,apiKey:'SECRET',arguments:'SECRET',outcome:'SECRET'};sink.record(row);for(let i=0;i<1000;i++)sink.record(row);await sink.flush();const text=await readFile(path,'utf8');assert.ok(!text.includes('SECRET'));assert.ok(sink.dropped>0);assert.equal(sink.errors,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
void test('independent sink failure remains observable without failing mechanics',async()=>{const dir=await mkdtemp(join(tmpdir(),'latency-independent-'));const path=join(dir,'blocked');await writeFile(path,'file');const sink=new LatencySink(join(path,'rows.jsonl'));sink.record({schemaVersion:1,traceId:id,component:'unit',stage:'test',elapsedMs:0});await sink.flush();assert.ok(sink.errors>0);assert.equal(sink.dropped,1);await rm(dir,{recursive:true,force:true});});


void test('independent synthetic sink enqueue overhead recorded separately from flush',async()=>{const dir=await mkdtemp(join(tmpdir(),'latency-independent-'));try{const sink=new LatencySink(join(dir,'rows.jsonl'));const started=performance.now();for(let i=0;i<200;i++)sink.record({schemaVersion:1,traceId:id,component:'unit',stage:'overhead',elapsedMs:0});const enqueueMs=performance.now()-started;const flushStart=performance.now();await sink.flush();await writeFile('../docs/latency-independent-node-overhead.json',JSON.stringify({synthetic:true,sampleCount:200,enqueueMs,meanEnqueueMs:enqueueMs/200,flushMs:performance.now()-flushStart,dropped:sink.dropped,errors:sink.errors,limits:'Local temp file diagnostics; not live action latency or benchmark.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}});
