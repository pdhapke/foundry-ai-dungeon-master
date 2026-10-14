import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {StreamableFoundryLocalApiMcpClient} from '../server/dist/integrations/foundry-local-api-mcp.js';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const env=require('dotenv').parse(readFileSync(new URL('../../foundry-local-api/server/.env',import.meta.url)));
const client=new StreamableFoundryLocalApiMcpClient({baseUrl:'http://127.0.0.1:3939',apiKey:env.API_KEY??env.FOUNDRY_API_KEY,clientVersion:'0.1.0'});
const file=new URL('../docs/core-rollout-evidence/live-fixture.json',import.meta.url);
const mode=process.argv[2]??'inspect';
const call=(name,args={})=>client.callTool({name,arguments:args,idempotencyKey:null});
let fixture=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
const save=()=>writeFileSync(file,JSON.stringify(fixture,null,2));
try {
 const status=await call('foundry_get_status');
 if(mode==='setup') {
  if(fixture) throw new Error('Fixture manifest already exists; inspect it rather than repeating creation.');
  if(status.systemId!=='dnd5e') throw new Error('Dedicated fixture requires the approved dnd5e world.');
  const scenes=await call('foundry_list_scenes'); const combats=await call('foundry_list_combats');
  const testRunId='test-ai-core-20261001-'+Date.now();
  fixture={testRunId,worldId:status.worldId,userId:status.userId,original:{sceneId:scenes.find(s=>s.active)?._id??null,paused:(await call('foundry_get_game_paused')).paused,activeCombatIds:combats.filter(c=>c.active).map(c=>c._id)},created:[],setupComplete:false}; save();
  await call('foundry_create_test_fixture_run',{testRunId});
  const flags={'foundry-local-api':{testRunId}};
  async function created(type,data,parentType,parentId) {const id=data._id??data.id;if(!id)throw new Error('Creation receipt missing ID'); fixture.created.push({documentType:type,id,...(parentId?{parentType,parentId}:{})});save();await call('foundry_record_test_fixture_document',{testRunId,document:fixture.created.at(-1)});return id;}
  const scene=await call('foundry_create_scene',{data:{name:'AI CORE TEST | '+testRunId,active:false,navigation:false,width:1200,height:1000,padding:0,grid:{size:100,type:1,distance:5,units:'ft'},tokenVision:false,flags}});
  fixture.sceneId=await created('Scene',scene);save();
  const actor=await call('foundry_create_actor',{data:{name:'AI CORE TEST | Practice Guard',type:'npc',system:{attributes:{hp:{value:20,max:20}}},flags}});
  fixture.actorId=await created('Actor',actor);save();
  const token=await call('foundry_create_scene_token',{sceneId:fixture.sceneId,data:{name:'Practice Guard',actorId:fixture.actorId,actorLink:true,x:200,y:200,width:1,height:1,flags}});
  fixture.tokenId=await created('Token',token,'Scene',fixture.sceneId);save();
  const wall=await call('foundry_create_scene_wall',{sceneId:fixture.sceneId,data:{c:[700,100,700,500],door:1,ds:0,flags}});
  fixture.doorId=await created('Wall',wall,'Scene',fixture.sceneId);save();
  const combat=await call('foundry_create_combat',{data:{scene:fixture.sceneId,active:false,round:1,turn:0,flags,combatants:[{name:'Practice Guard',actorId:fixture.actorId,tokenId:fixture.tokenId,sceneId:fixture.sceneId,initiative:20},{name:'Practice Opponent',initiative:10}]}});
  fixture.combatId=await created('Combat',combat);fixture.combatantIds=combat.combatants.map(c=>c._id);fixture.setupComplete=true;save();
  console.log(JSON.stringify({mode,result:'created inactive dedicated fixtures',fixture}));
 } else if(mode==='activate') {
  if(!fixture?.setupComplete||status.worldId!==fixture.worldId||status.userId!==fixture.userId)throw new Error('Fixture world/GM mismatch');
  await call('foundry_activate_scene',{id:fixture.sceneId});
  await call('foundry_update_combat',{id:fixture.combatId,changes:{active:true}});
  console.log(JSON.stringify({mode,sceneId:fixture.sceneId,combatId:fixture.combatId}));
 } else if(mode==='restore') {
  if(!fixture||status.worldId!==fixture.worldId)throw new Error('Fixture world mismatch');
  await call('foundry_update_combat',{id:fixture.combatId,changes:{active:false}});
  if(fixture.original.sceneId) await call('foundry_activate_scene',{id:fixture.original.sceneId});
  for(const id of fixture.original.activeCombatIds)await call('foundry_update_combat',{id,changes:{active:true}});
  await call('foundry_update_actor',{id:fixture.actorId,changes:{'system.attributes.hp.value':20}});
  await call('foundry_update_scene_token',{sceneId:fixture.sceneId,tokenId:fixture.tokenId,changes:{x:200,y:200}});
  await call('foundry_update_scene_wall',{sceneId:fixture.sceneId,placeableId:fixture.doorId,changes:{ds:0}});
  await call('foundry_update_combat',{id:fixture.combatId,changes:{round:1,turn:0,active:false}});
  await call('foundry_set_game_paused',{paused:fixture.original.paused});
  fixture.restoredAt=new Date().toISOString();save();console.log(JSON.stringify({mode,result:'original scene/combat/pause restored; test fixtures kept inactive',original:fixture.original}));
 } else if(mode==='inspect') {
  console.log(JSON.stringify({mode,status,fixture,state:fixture?{scene:await call('foundry_get_scene',{id:fixture.sceneId}),actor:await call('foundry_get_actor',{id:fixture.actorId}),combat:await call('foundry_get_combat',{id:fixture.combatId}),pause:await call('foundry_get_game_paused')}:null}));
 } else throw new Error('Unknown mode');
} catch(error) {console.log(JSON.stringify({mode,result:'failed',reason:error instanceof Error?error.message:'unknown',manifestSaved:!!fixture}));process.exitCode=1;} finally {await client.close();}

