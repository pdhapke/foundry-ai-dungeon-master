import { open, call } from './phase4-live-client.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { projectPlayerPerception } from '../server/dist/chatkit/player-perception.js';
// PREPARED ONLY. Root runs modes deliberately; no model/service calls exist here.
const mode=process.argv[2], file='docs/phase5-live-fixture.json', userId='edtBL96Yu3058QAT';
if(!['capture','setup','read','restore'].includes(mode)) throw Error('Choose capture/setup/read/restore');
let ledger=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
const save=()=>{writeFileSync(file+'.tmp',JSON.stringify(ledger,null,2),'utf8');renameSync(file+'.tmp',file);};
const client=await open();
const cid=()=>`phase5-${randomUUID()}`;
const id=()=>randomBytes(8).toString('hex');
async function mutation(label,name,args){const setting=await call(client,'foundry_get_setting',{namespace:'foundry-ai-dungeon-master',key:'automaticEventsEnabled'});if(setting?.value!==false)throw Error('Automatic events must already be false; mutation blocked, no toggle');ledger.operations.push({label,name,startedAt:new Date().toISOString(),state:'pending'});save();const row=ledger.operations.at(-1);try{const value=await call(client,name,args);if(name.startsWith('foundry_create_')&&!value?._id)throw Error('Missing created document identity');row.acknowledgement={documentId:value?._id??null,acknowledged:value?.acknowledged??null};row.state='confirmed';row.confirmedAt=new Date().toISOString();save();return value;}catch{row.state='uncertain';save();throw Error(`${label} uncertain; inspect recorded predetermined IDs, do not blindly retry`);}}
async function documentExists(kind,docId){const documents=await call(client,kind==='scene'?'foundry_list_scenes':'foundry_list_actors');if(!Array.isArray(documents))throw Error(`Cannot establish ${kind} collection; cleanup stopped`);if(!documents.some(doc=>(doc._id??doc.id)===docId))return null;return await call(client,`foundry_get_${kind}`,{id:docId});}
try {
 if(mode==='capture'){
  if(ledger&&!ledger.restored)throw Error('Existing unfinished fixture ledger: preserve it');
  const capabilities=await call(client,'foundry_get_capability_report');
  const player=capabilities.clients.filter(c=>c.userId===userId&&c.lane==='player'&&!c.isGM&&c.optedIn);
  const gm=capabilities.clients.filter(c=>c.isGM&&c.lane==='gm'&&c.optedIn);
  if(player.length!==1||gm.length<1)throw Error('Need exactly one opted-in Izzy player and connected GM');
  const receivers=[gm[0],player[0]];
  const views=[];
  for(const c of receivers){const r=await call(client,'foundry_get_client_readiness',{clientId:c.clientId,correlationId:cid()});const v=r.result??r.value??r.readiness??r;views.push({clientId:c.clientId,userId:c.userId,readiness:v});}
  const scenes=await call(client,'foundry_list_scenes');
  ledger={version:1,owner:'phase5-disposable',runId:randomUUID(),capturedAt:new Date().toISOString(),userId,playerClientId:player[0].clientId,activeSceneId:scenes.find(s=>s.active)?._id??null,views,pause:await call(client,'foundry_get_game_paused'),worldId:(await call(client,'foundry_get_status')).worldId,automaticEvents:await call(client,'foundry_get_setting',{namespace:'foundry-ai-dungeon-master',key:'automaticEventsEnabled'}),originalFog:[],ids:{sceneId:id(),actorId:id(),tokenId:id(),targetId:id(),hiddenTargetId:id(),doorId:id(),lightId:id()},operations:[],restored:false};
  for(const view of views){const sid=view.readiness.activeSceneId;if(!sid||!view.readiness.viewport)throw Error('Original client scene/viewport missing; setup prohibited');ledger.originalFog.push(await call(client,'foundry_get_scene_fog',{sceneId:sid,userId:view.userId}));}
  if(!ledger.worldId||typeof ledger.worldId!=='string')throw Error('Missing world identity');if(ledger.automaticEvents?.value!==false)throw Error('Automatic events are not false; fixture prohibited');save();console.log('Fresh original state captured; no mutations.');
 }
 if(mode==='setup'){
  if(!ledger||ledger.restored||ledger.operations.length)throw Error('Fresh capture required; repeated setup prohibited');
  const liveStatus=await call(client,'foundry_get_status');const liveClients=(await call(client,'foundry_get_capability_report')).clients;if(liveStatus.worldId!==ledger.worldId||!liveClients.some(c=>c.clientId===ledger.playerClientId&&c.userId===userId&&c.lane==='player'&&!c.isGM&&c.optedIn))throw Error('World/player consent changed; setup blocked');
  let {sceneId,actorId,tokenId,targetId,hiddenTargetId,doorId,lightId}=ledger.ids;
  const flag={ 'foundry-local-api':{phase5Fixture:ledger.runId}};
  const actor=await mutation('create actor','foundry_create_actor',{data:{_id:actorId,name:'Phase5 disposable player observer',type:'npc',ownership:{default:0,[userId]:3},flags:flag,prototypeToken:{sight:{enabled:true,range:60,visionMode:'basic'}}}});
  actorId=ledger.ids.actorId=actor._id;save();
  const scene=await mutation('create scene','foundry_create_scene',{data:{_id:sceneId,name:'Phase5 disposable perception fixture',ownership:{default:0,[userId]:2},width:1200,height:800,padding:0,backgroundColor:'#777777',grid:{type:1,size:100,distance:5,units:'ft'},tokenVision:true,fogExploration:true,environment:{darknessLevel:0,globalLight:{enabled:true}},flags:flag,walls:[{_id:doorId,c:[600,0,600,800],move:20,sight:20,light:20,sound:20,door:1,ds:0}],lights:[{_id:lightId,x:300,y:400,elevation:0,config:{dim:30,bright:15,color:'#ffffff',alpha:0.5}}]}});
  sceneId=ledger.ids.sceneId=scene._id;ledger.ids.doorId=scene.walls?.[0]?._id;ledger.ids.lightId=scene.lights?.[0]?._id;save();
  for(const [tid,x,y,hidden,owned]of[[tokenId,200,350,false,true],[targetId,850,350,false,false],[hiddenTargetId,300,550,true,false]]){const token=await mutation(`create token ${tid}`,'foundry_create_scene_token',{sceneId,data:{_id:tid,name:owned?'Observer':'Disposable target',actorId:owned?actorId:null,actorLink:owned,x,y,width:1,height:1,elevation:0,hidden,texture:{src:'icons/svg/mystery-man.svg'},sight:{enabled:owned,range:60,visionMode:'basic'},detectionModes:owned?[{id:'basicSight',range:60,enabled:true}]:[],flags:flag}});ledger.ids[owned?'tokenId':hidden?'hiddenTargetId':'targetId']=token._id;save();}
  ledger.setupComplete=true;save();
  console.log(JSON.stringify({ids:ledger.ids,next:'Root may apply targeted viewport to this scene, then read. Scene is not activated; pause/settings/original fog untouched.'}));
 }
 if(mode==='read'){
  if(!ledger?.setupComplete)throw Error('Fixture setup incomplete');
  const native=await call(client,'foundry_get_token_visibility',{sceneId:ledger.ids.sceneId,effectiveUserId:userId,clientId:ledger.playerClientId,tokenId:ledger.ids.tokenId,queryPoints:[{id:'behind-door',x:900,y:400,elevation:0},{id:'near-observer',x:250,y:400,elevation:0}]});
  const worldId=ledger.worldId;
  const projection=projectPlayerPerception(native,{sceneId:ledger.ids.sceneId,effectiveUserId:userId,tokenId:ledger.ids.tokenId},worldId??'missing');
  const stamp=Date.now();writeFileSync(`docs/phase5-live-read-${stamp}.json`,JSON.stringify({capturedAt:new Date().toISOString(),native,projection,projectionBasis:'compiled disk helper, not authenticated AI adapter dispatch',projectionSha256:createHash('sha256').update(readFileSync('server/dist/chatkit/player-perception.js')).digest('hex')},null,2),'utf8');
  console.log(JSON.stringify({status:native.status,readiness:native.observation?.readiness,projectionStatus:projection.status,evidenceFile:`docs/phase5-live-read-${stamp}.json`}));
 }
 if(mode==='restore'){
  if(!ledger)throw Error('No ledger');
  if(ledger.operations.some(o=>o.state==='uncertain'))throw Error('Uncertain operation requires explicit reconciliation by unique fixture flag before cleanup; no blind replay');
  // Never delete another scene/actor: exact recorded actual ID plus unique fixture flag; unresolved creation must be inspected manually.
  const viewChecks=[];for(const view of ledger.views){const v=view.readiness;await mutation('restore client view','foundry_apply_client_viewport',{clientId:view.clientId,sceneId:v.activeSceneId,viewport:v.viewport,correlationId:cid()});const check=await call(client,'foundry_get_client_readiness',{clientId:view.clientId,correlationId:cid()});const observed=check.viewport;const exact=check.executingClientId===view.clientId&&check.clientUserId===view.userId&&check.activeSceneId===v.activeSceneId&&observed&&Math.abs(observed.x-v.viewport.x)<=1&&Math.abs(observed.y-v.viewport.y)<=1&&Math.abs(observed.scale-v.viewport.scale)<=0.001;viewChecks.push({clientId:view.clientId,sceneMatches:check.activeSceneId===v.activeSceneId,viewportMatches:!!exact,tolerance:{positionPixels:1,scale:0.001}});if(!exact){ledger.restoreVerification={viewChecks,blocked:'Client view restoration readback mismatch'};save();throw Error('Client view readback mismatch; cleanup blocked');}}
  const ownedScene=await documentExists('scene',ledger.ids.sceneId);if(ownedScene&&ownedScene.flags?.['foundry-local-api']?.phase5Fixture!==ledger.runId)throw Error('Fixture scene identity mismatch: refuse fog cleanup');
  if(ledger.setupComplete&&ownedScene){for(const fogUser of new Set(ledger.views.map(v=>v.userId))){const fog=await call(client,'foundry_get_scene_fog',{sceneId:ledger.ids.sceneId,userId:fogUser});if(fog.exists)await mutation('remove fixture fog','foundry_update_scene_fog',{sceneId:ledger.ids.sceneId,userId:fogUser,mode:'replace',state:{explored:null,positions:{}},expectedRevision:fog.revision,idempotencyKey:cid(),removeDocument:true});}}
  for(const [kind,docId]of[['scene',ledger.ids.sceneId],['actor',ledger.ids.actorId]]){const doc=await documentExists(kind,docId);if(!doc)continue;if(doc.flags?.['foundry-local-api']?.phase5Fixture!==ledger.runId)throw Error('Fixture identity mismatch: refuse deletion');await mutation(`delete fixture ${kind}`,`foundry_delete_${kind}`,{id:docId});if(await documentExists(kind,docId))throw Error('Deletion readback failed');}
  // Original fog was never directly altered. Check hashes/state without overwriting newer state.
  const fogChecks=[];for(const before of ledger.originalFog){const after=await call(client,'foundry_get_scene_fog',{sceneId:before.sceneId,userId:before.userId});fogChecks.push({sceneId:before.sceneId,userId:before.userId,unchanged:JSON.stringify(before.state)===JSON.stringify(after.state)});}
  const scenes=await call(client,'foundry_list_scenes');const activeSceneId=scenes.find(s=>s.active)?._id??null;
  ledger.restoreVerification={viewChecks,activeSceneUnchanged:activeSceneId===ledger.activeSceneId,pauseUnchanged:JSON.stringify(await call(client,'foundry_get_game_paused'))===JSON.stringify(ledger.pause),automaticEventsUnchanged:JSON.stringify(await call(client,'foundry_get_setting',{namespace:'foundry-ai-dungeon-master',key:'automaticEventsEnabled'}))===JSON.stringify(ledger.automaticEvents),fogChecks};ledger.restored=Object.values(ledger.restoreVerification).filter(v=>typeof v==='boolean').every(Boolean)&&fogChecks.every(c=>c.unchanged)&&viewChecks.every(c=>c.viewportMatches);save();console.log(JSON.stringify(ledger.restoreVerification));
 }
} finally {await client.close();}
