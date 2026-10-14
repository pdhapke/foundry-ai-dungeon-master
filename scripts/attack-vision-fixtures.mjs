import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {StreamableFoundryLocalApiMcpClient} from '../server/dist/integrations/foundry-local-api-mcp.js';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const env=require('dotenv').parse(readFileSync(new URL('../../foundry-local-api/server/.env',import.meta.url)));
const client=new StreamableFoundryLocalApiMcpClient({baseUrl:'http://127.0.0.1:3939',apiKey:env.API_KEY??env.FOUNDRY_API_KEY,clientVersion:'0.1.0'});
const file=new URL('../docs/attack-vision-evidence/live-fixture.json',import.meta.url);
const mode=process.argv[2]??'inspect';
const call=(name,args={})=>client.callTool({name,arguments:args,idempotencyKey:null});
let fixture=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
const save=()=>writeFileSync(file,JSON.stringify(fixture,null,2));
try {
 const status=await call('foundry_get_status');
 if(mode==='setup') {
  if(fixture)throw Error('Existing fixture manifest; do not repeat creation');
  if(status.systemId!=='dnd5e')throw Error('Dedicated dnd5e world required');
  const scenes=await call('foundry_list_scenes'),combats=await call('foundry_list_combats');
  const users=await call('foundry_list_users');const tv=users.find(u=>u.name==='TV'&&!u.isGM);if(!tv)throw Error('Existing nonGM TV user required');
  fixture={testRunId:'test-ai-attack-vision-'+Date.now(),worldId:status.worldId,userId:status.userId,playerUserId:tv.id,original:{sceneId:scenes.find(s=>s.active)?._id??null,paused:(await call('foundry_get_game_paused')).paused,activeCombatIds:combats.filter(c=>c.active).map(c=>c._id)},created:[],setupComplete:false};save();
  await call('foundry_create_test_fixture_run',{testRunId:fixture.testRunId});
  const flags={'foundry-local-api':{testRunId:fixture.testRunId}};
  const created=async(documentType,data,parentType,parentId)=>{const id=data._id??data.id;if(!id)throw Error('Creation missing ID');const d={documentType,id,...(parentId?{parentType,parentId}:{})};fixture.created.push(d);save();await call('foundry_record_test_fixture_document',{testRunId:fixture.testRunId,document:d});return id;};
  const scene=await call('foundry_create_scene',{data:{name:'AI ATTACK VISION TEST | '+fixture.testRunId,active:false,navigation:false,width:1200,height:900,padding:0,grid:{size:100,type:1,distance:5,units:'ft'},tokenVision:true,environment:{globalLight:{enabled:true,bright:true}},flags}});
  fixture.sceneId=await created('Scene',scene);save();
  const attacker=await call('foundry_create_actor',{data:{name:'AI TEST | Practice Attacker',type:'npc',ownership:{default:0,[tv.id]:3},system:{abilities:{str:{value:16}},attributes:{hp:{value:20,max:20},ac:{calc:'flat',flat:15}}},flags}});
  fixture.actorId=await created('Actor',attacker);save();
  const victim=await call('foundry_create_actor',{data:{name:'AI TEST | Practice Target',type:'npc',ownership:{default:0},system:{attributes:{hp:{value:40,max:40,temp:4},ac:{calc:'flat',flat:10}}},flags}});
  fixture.targetActorId=await created('Actor',victim);save();
  fixture.activityId='AttackFixture001';
  const item=await call('foundry_create_actor_item',{actorId:fixture.actorId,data:{name:'AI TEST | Fixture Club',type:'weapon',system:{quantity:1,type:{value:'simpleM',baseItem:'club'},properties:[],proficient:1,damage:{base:{number:1,denomination:4,bonus:'',types:['bludgeoning'],custom:{enabled:false,formula:''}},versatile:{number:0,denomination:0,bonus:'',types:[],custom:{enabled:false,formula:''}}},activities:{[fixture.activityId]:{_id:fixture.activityId,type:'attack',name:'Fixture Club',activation:{type:'action',value:1},attack:{ability:'str',bonus:'',flat:false,type:{value:'melee',classification:'weapon'},critical:{threshold:20}},damage:{includeBase:true,parts:[],critical:{bonus:''}},consumption:{targets:[],spellSlot:false},effects:[]}}},flags}});
  fixture.itemId=await created('Item',item,'Actor',fixture.actorId);save();
  fixture.tokenId=await created('Token',await call('foundry_create_scene_token',{sceneId:fixture.sceneId,data:{name:'Practice Attacker',actorId:fixture.actorId,actorLink:true,x:300,y:400,width:1,height:1,sight:{enabled:true,range:0,visionMode:'basic'},texture:{src:'icons/svg/mystery-man.svg'},flags}}),'Scene',fixture.sceneId);save();
  fixture.targetTokenId=await created('Token',await call('foundry_create_scene_token',{sceneId:fixture.sceneId,data:{name:'Practice Target',actorId:fixture.targetActorId,actorLink:true,x:700,y:400,width:1,height:1,texture:{src:'icons/svg/target.svg'},flags}}),'Scene',fixture.sceneId);save();
  for(const [c,door]of[[[600,0,600,350],0],[[600,350,600,550],1],[[600,550,600,900],0]]){const wall=await call('foundry_create_scene_wall',{sceneId:fixture.sceneId,data:{c,door,ds:0,flags}});const id=await created('Wall',wall,'Scene',fixture.sceneId);if(door)fixture.doorId=id;save();}
  fixture.lightId=await created('AmbientLight',await call('foundry_create_scene_light',{sceneId:fixture.sceneId,data:{x:450,y:450,hidden:false,config:{dim:20,bright:10},flags}}),'Scene',fixture.sceneId);fixture.setupComplete=true;save();
  console.log(JSON.stringify({mode,result:'dedicated inactive fixture created',sceneId:fixture.sceneId}));
 }else if(mode==='activate'){
  if(!fixture?.setupComplete||status.worldId!==fixture.worldId||status.userId!==fixture.userId)throw Error('Fixture scope mismatch');
  await call('foundry_activate_scene',{id:fixture.sceneId});await call('foundry_set_game_paused',{paused:false});console.log(JSON.stringify({mode,sceneId:fixture.sceneId}));
 }else if(mode==='restore'){
  if(!fixture||status.worldId!==fixture.worldId)throw Error('Fixture scope mismatch');
  if(fixture.original.sceneId)await call('foundry_activate_scene',{id:fixture.original.sceneId});
  for(const id of fixture.original.activeCombatIds)await call('foundry_update_combat',{id,changes:{active:true}});
  await call('foundry_update_actor',{id:fixture.targetActorId,changes:{'system.attributes.hp.value':40,'system.attributes.hp.temp':4}});
  await call('foundry_update_scene_token',{sceneId:fixture.sceneId,tokenId:fixture.tokenId,changes:{x:300,y:400}});
  await call('foundry_update_scene_wall',{sceneId:fixture.sceneId,placeableId:fixture.doorId,changes:{ds:0}});
  await call('foundry_update_scene',{id:fixture.sceneId,changes:{'environment.globalLight.enabled':true}});
  await call('foundry_update_scene_light',{sceneId:fixture.sceneId,placeableId:fixture.lightId,changes:{hidden:false}});
  await call('foundry_set_game_paused',{paused:fixture.original.paused});fixture.restoredAt=new Date().toISOString();save();console.log(JSON.stringify({mode,result:'restored original state; fixtures inactive'}));
 }else if(mode==='inspect'){console.log(JSON.stringify({mode,status,fixture:fixture?{sceneId:fixture.sceneId,setupComplete:fixture.setupComplete,restoredAt:fixture.restoredAt}:null}));}
 else throw Error('Unknown mode');
}catch(error){console.log(JSON.stringify({mode,result:'failed',message:error instanceof Error?error.message:'unknown',manifestSaved:!!fixture}));process.exitCode=1;}finally{await client.close();}
