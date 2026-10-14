import {open,call} from './phase4-live-client.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
const file='docs/prompt4-live-fixture-ledger.json'; const l=JSON.parse(readFileSync(file)); const c=await open();
try { if(l.restored || l.operations.some(o=>['pending','uncertain'].includes(o.state))) throw Error('Ledger guard');
const r=await call(c,'foundry_get_client_readiness',{clientId:l.player.clientId,correlationId:"prompt4-center-check-"+l.runId}); if(r.activeSceneId!==l.ids.sceneId || r.clientUserId!==l.userId)throw Error('Exact player scene guard');
const row={label:'center primary for native source release',name:'foundry_apply_client_viewport',state:'pending',args:{clientId:l.player.clientId,sceneId:l.ids.sceneId,viewport:{x:250,y:400,scale:1},correlationId:'prompt4-source-release-'+l.runId}};l.operations.push(row);writeFileSync(file,JSON.stringify(l,null,2));
try{row.receipt=await call(c,row.name,row.args);row.state='confirmed';}catch{row.state='uncertain';throw Error('Viewport uncertain');}finally{writeFileSync(file,JSON.stringify(l,null,2));}
console.log(JSON.stringify({applied:row.state,secondId:l.ids.secondId}));
}finally{await c.close();}

