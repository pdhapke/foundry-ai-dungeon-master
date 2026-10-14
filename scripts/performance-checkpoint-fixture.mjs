import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {StreamableFoundryLocalApiMcpClient} from '../server/dist/integrations/foundry-local-api-mcp.js';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const env=require('dotenv').parse(readFileSync(new URL('../../foundry-local-api/server/.env',import.meta.url)));
const client=new StreamableFoundryLocalApiMcpClient({baseUrl:'http://127.0.0.1:3939',apiKey:env.API_KEY??env.FOUNDRY_API_KEY,clientVersion:'0.1.0'});
const before=JSON.parse(readFileSync(new URL('../docs/performance-checkpoint-live-before.json',import.meta.url),'utf8'));
const f=before.fixture,s=before.state,mode=process.argv[2];
const evidence=[];
async function call(name,args={}){const result=await client.callTool({name,arguments:args,idempotencyKey:null});if(result?.error)throw Error(result.error.code??'Fixture call failed');evidence.push({name,args,result});return result;}
try{
 const status=await call('foundry_get_status');
 if(status.worldId!==f.worldId||status.userId!==f.userId||Date.now()-Date.parse(before.capturedAt)>3600000)throw Error('Fresh fixture world/GM scope required');
 if(mode==='activate'){
  await call('foundry_activate_scene',{id:f.sceneId});
  await call('foundry_update_combat',{id:f.combatId,changes:{active:true}});
 }else if(mode==='restore'){
  const token=s.scene.tokens.find(t=>t._id===f.tokenId),wall=s.scene.walls.find(w=>w._id===f.doorId);
  await call('foundry_update_actor',{id:f.actorId,changes:{'system.attributes.hp.value':s.actor.system.attributes.hp.value,'system.attributes.hp.temp':s.actor.system.attributes.hp.temp}});
  await call('foundry_update_scene_token',{sceneId:f.sceneId,tokenId:f.tokenId,changes:{x:token.x,y:token.y}});
  await call('foundry_update_scene_wall',{sceneId:f.sceneId,placeableId:f.doorId,changes:{ds:wall.ds}});
  await call('foundry_update_combat',{id:f.combatId,changes:{round:s.combat.round,turn:s.combat.turn,active:s.combat.active}});
  const active=s.scenes.find(v=>v.active);if(active)await call('foundry_activate_scene',{id:active._id});
  for(const combat of s.combats.filter(c=>c.active))await call('foundry_update_combat',{id:combat._id,changes:{active:true}});
  await call('foundry_set_game_paused',{paused:s.pause.paused});
 }else throw Error('Unknown fixture operation');
 console.log(JSON.stringify({mode,status:'completed'}));
}catch(error){console.log(JSON.stringify({mode,status:'failed',message:error.message}));process.exitCode=1;}
finally{writeFileSync(new URL(`../docs/performance-checkpoint-live-${mode}-receipts.json`,import.meta.url),JSON.stringify(evidence,null,2));await client.close();}
