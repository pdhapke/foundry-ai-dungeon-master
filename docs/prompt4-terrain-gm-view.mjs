import {open,call} from './phase4-live-client.mjs';import {readFileSync,writeFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
const mode=process.argv[2];if(!['focus','restore'].includes(mode))throw Error('Mode required');
const before=JSON.parse(readFileSync('docs/prompt4-terrain-state-before.json')),gm=before.views.find(v=>v.userId==='X7X4KK7zca5U2Ics');
const viewport=mode==='restore'?gm.viewport:{x:before.token.x+25,y:before.token.y+25,scale:1};
const c=await open();try{const r=await call(c,'foundry_apply_client_viewport',{clientId:gm.clientId,userId:gm.userId,sceneId:gm.sceneId,viewport,correlationId:randomUUID()});writeFileSync(`docs/prompt4-terrain-gm-view-${mode}.json`,JSON.stringify(r,null,2));console.log(JSON.stringify({mode,viewport:r.viewport,sceneId:r.activeSceneId}));}finally{await c.close();}
