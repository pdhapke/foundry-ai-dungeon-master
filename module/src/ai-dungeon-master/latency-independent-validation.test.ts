import assert from 'node:assert/strict';
import test from 'node:test';
import {BrowserLatencyProbe,latencyRows,latencyDiagnostics} from './latency-probe.js';
void test('independent UTF8 fragmented stream receipt records metadata only with same document clock',()=>{
 const p=new BrowserLatencyProbe(),q=new BrowserLatencyProbe();assert.equal(p.clockId,q.clockId);assert.notEqual(p.traceId,q.traceId);
 const bytes=new TextEncoder().encode('data: '+JSON.stringify({type:'thread.item.done',item:{id:'msg_receipt_private',content:[{text:'PRIVATE 🔒 secret'}]}})+'\n\n');for(const b of bytes)p.chunk(new Uint8Array([b]));
 const mine=latencyRows().filter(x=>x.traceId===p.traceId);assert.equal(mine.filter(x=>x.stage==='browser-receipt-arrival').length,1);assert.ok(!JSON.stringify(mine).includes('PRIVATE'));assert.ok(!mine.some(x=>x.stage.includes('render')||x.stage.includes('paint')));
});
void test('independent direct JSON receipt and loss counters remain explicit',()=>{
 const p=new BrowserLatencyProbe();p.chunk(new TextEncoder().encode(JSON.stringify({result:{outcome:'confirmed',private:'SECRET'}})));p.finish();assert.ok(latencyRows().some(x=>x.traceId===p.traceId&&x.stage==='browser-action-receipt-arrival'));
 const before=latencyDiagnostics();for(let i=0;i<1100;i++)p.mark('unit');p.chunk(new TextEncoder().encode('x'.repeat(70000)));const after=latencyDiagnostics();assert.ok(after.droppedRows>before.droppedRows);assert.ok(after.overBudgetEvents>before.overBudgetEvents);assert.ok(latencyRows().length<=1000);assert.ok(!JSON.stringify(latencyRows()).includes('SECRET'));
});
