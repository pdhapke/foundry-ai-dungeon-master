import {open,call} from './phase4-live-client.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const mode=process.argv[2];if(!['before','after'].includes(mode))throw Error('Choose before or after');
const path=`docs/prompt4-terrain-state-${mode}.json`;
const sceneId='Nbj38PEdvw1zX1J9',tokenId='5afpFlCHHnclifNw';
const c=await open();try {
 const caps=await call(c,'foundry_get_capability_report'),world=await call(c,'foundry_get_status');
 if(world.worldId!=='izzy-campaign')throw Error('Exact world required');
 const targets=[['80f7f865-6ebf-4a83-ad44-33ab0c0747f2','edtBL96Yu3058QAT',false],['6489d1c8-8937-42ce-8126-ef036fdfadd5','X7X4KK7zca5U2Ics',true]];
 const views=[];for(const [clientId,userId,isGM] of targets){const client=caps.clients.find(v=>v.clientId===clientId&&v.userId===userId&&v.isGM===isGM&&v.optedIn);if(!client)throw Error('Exact consenting client required');const r=await call(c,'foundry_get_client_readiness',{clientId,userId,correlationId:randomUUID()});if(r.activeSceneId!==sceneId)throw Error('Original scene required');views.push({clientId,userId,connectedAt:client.connectedAt,sceneId:r.activeSceneId,viewport:r.viewport});}
 const scene=await call(c,'foundry_get_scene',{id:sceneId}),token=scene.tokens.find(t=>(t._id??t.id)===tokenId);
 if(!token||token.light.bright!==20||token.light.dim!==40)throw Error('Confirmed torch target required');
 const actor=await call(c,'foundry_get_actor',{id:token.actorId});if((actor.ownership?.edtBL96Yu3058QAT??actor.ownership?.default??0)<3)throw Error('Current ownership required');
 const record={capturedAt:new Date().toISOString(),mode,worldId:world.worldId,scene,token,actor,views,pause:await call(c,'foundry_get_game_paused'),combats:await call(c,'foundry_list_combats'),automaticEvents:await call(c,'foundry_get_setting',{namespace:'foundry-ai-dungeon-master',key:'automaticEventsEnabled'}),fog:await Promise.all(targets.map(([,userId])=>call(c,'foundry_get_scene_fog',{sceneId,userId}))),inferenceRequests:0,mutations:0,scope:'Read-only original-scene capture for human-performed short torch movement; fog is never cleared.'};
 if(mode==='after'){const before=JSON.parse(readFileSync('docs/prompt4-terrain-state-before.json'));record.movement={from:{x:before.token.x,y:before.token.y,elevation:before.token.elevation},to:{x:token.x,y:token.y,elevation:token.elevation}};}
 writeFileSync(path,JSON.stringify(record,null,2));console.log(JSON.stringify({mode,position:{x:token.x,y:token.y,elevation:token.elevation},light:{bright:token.light.bright,dim:token.light.dim},pause:record.pause,views:views.map(v=>({clientId:v.clientId,viewport:v.viewport})),movement:record.movement}));
}finally{await c.close();}


