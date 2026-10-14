import { open, call } from './phase4-live-client.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const fixture=JSON.parse(readFileSync('docs/phase5-live-fixture.json','utf8'));
const step=process.argv[2];
const scenarios={
  open:['foundry_update_scene_wall',{sceneId:fixture.ids.sceneId,placeableId:fixture.ids.doorId,changes:{ds:1}}],
  closed:['foundry_update_scene_wall',{sceneId:fixture.ids.sceneId,placeableId:fixture.ids.doorId,changes:{ds:0}}],
  dark:['foundry_update_scene',{id:fixture.ids.sceneId,changes:{'environment.globalLight.enabled':false,'environment.darknessLevel':1}}],
  daylight:['foundry_update_scene',{id:fixture.ids.sceneId,changes:{'environment.globalLight.enabled':true,'environment.darknessLevel':0}}],
  lightoff:['foundry_update_scene_light',{sceneId:fixture.ids.sceneId,placeableId:fixture.ids.lightId,changes:{hidden:true}}],
  lighton:['foundry_update_scene_light',{sceneId:fixture.ids.sceneId,placeableId:fixture.ids.lightId,changes:{hidden:false}}],
  elevation:['foundry_update_scene_token',{sceneId:fixture.ids.sceneId,tokenId:fixture.ids.tokenId,changes:{elevation:10}}],
  walk:['foundry_core_action_confirmed',{schemaVersion:'core-actions-v1',worldId:fixture.worldId,userId:'X7X4KK7zca5U2Ics',origin:'ai-dm',requestId:randomUUID(),correlationId:randomUUID(),action:{kind:'token.position',sceneId:fixture.ids.sceneId,targetId:fixture.ids.tokenId,x:300,y:350,mode:'walk'}}],
  blockedwalk:['foundry_core_action_confirmed',{schemaVersion:'core-actions-v1',worldId:fixture.worldId,userId:'X7X4KK7zca5U2Ics',origin:'ai-dm',requestId:randomUUID(),correlationId:randomUUID(),action:{kind:'token.position',sceneId:fixture.ids.sceneId,targetId:fixture.ids.tokenId,x:850,y:350,mode:'walk'}}],
};
if(!scenarios[step])throw Error('Unknown bounded fixture step');
const path='docs/phase5-live-steps.json';
const log=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];
if(log.some(row=>row.state==='uncertain'))throw Error('Uncertain step requires inspection; no blind retry');
const client=await open();
try{
  const auto=await call(client,'foundry_get_setting',{namespace:'foundry-ai-dungeon-master',key:'automaticEventsEnabled'});
  if(auto.value!==false)throw Error('Automatic events must remain disabled');
  const scene=await call(client,'foundry_get_scene',{id:fixture.ids.sceneId});
  if(scene.flags?.['foundry-local-api']?.phase5Fixture!==fixture.runId)throw Error('Dedicated fixture identity mismatch');
  const row={step,startedAt:new Date().toISOString(),state:'pending',tool:scenarios[step][0],args:scenarios[step][1]};
  log.push(row);writeFileSync(path,JSON.stringify(log,null,2),'utf8');
  try{row.result=await call(client,...scenarios[step]);row.state='confirmed';}
  catch(error){row.state='uncertain';row.error=String(error);throw error;}
  finally{row.endedAt=new Date().toISOString();writeFileSync(path,JSON.stringify(log,null,2),'utf8');}
  console.log(JSON.stringify({step,state:row.state,result:row.result}));
}finally{await client.close();}
