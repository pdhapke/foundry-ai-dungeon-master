import {open,call} from './phase4-live-client.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const sceneId='Nbj38PEdvw1zX1J9',tokenId='5afpFlCHHnclifNw',userId='edtBL96Yu3058QAT',gmId='X7X4KK7zca5U2Ics';
const identities=JSON.parse(readFileSync('docs/prompt4-token-light-native-identity.json'));
if(identities.gate!=='PASS')throw Error('Loaded native gate required');
const c=await open();
const report={capturedAt:new Date().toISOString(),inferenceRequests:0};
try {
 const tools=await c.listTools();if(!tools.tools.some(t=>t.name==='foundry_set_token_light'))throw Error('Loaded endpoint absent');
 report.viewportRestoration=[];
 for(const lane of ['gm','player']) {
  const before=JSON.parse(readFileSync(`docs/prompt4-token-light-${lane}-reload.json`)).before;
  const receipt=await call(c,'foundry_apply_client_viewport',{clientId:before.executingClientId,userId:before.clientUserId,sceneId:before.activeSceneId,viewport:before.viewport,correlationId:randomUUID()});
  report.viewportRestoration.push({lane,before:before.viewport,after:receipt.viewport,sceneId:receipt.activeSceneId});
 }
 const capture=async()=>{
  const caps=await call(c,'foundry_get_capability_report');
  for(const r of identities.receivers){if(!caps.clients.some(v=>v.clientId===r.target.clientId&&v.userId===r.target.userId&&v.isGM===r.target.isGM&&v.optedIn))throw Error('Exact receiver unavailable');}
  const scene=await call(c,'foundry_get_scene',{id:sceneId});
  const token=scene.tokens.find(t=>(t._id??t.id)===tokenId);if(!token||token.actorId!=='P9YnTVjX8thvZ8eM'||!token.sight?.enabled||!['basic','darkvision'].includes(token.sight.visionMode))throw Error('Exact supported token required');
  const actor=await call(c,'foundry_get_actor',{id:token.actorId});if((actor.ownership?.[userId]??actor.ownership?.default??0)<3)throw Error('Current Izzy ownership required');
  const views=[];for(const r of identities.receivers){const v=await call(c,'foundry_get_client_readiness',{clientId:r.target.clientId,userId:r.target.userId,correlationId:randomUUID()});if(v.activeSceneId!==sceneId||v.clientUserId!==r.target.userId)throw Error('Exact active player/GM scene required');views.push({clientId:r.target.clientId,sceneId:v.activeSceneId,viewport:v.viewport});}
  const automaticEvents=await call(c,'foundry_get_setting',{namespace:'foundry-ai-dungeon-master',key:'automaticEventsEnabled'});if(automaticEvents.value!==false)throw Error('Automatic events guard');
  return {scene,actor,token,views,automaticEvents,pause:await call(c,'foundry_get_game_paused'),combats:await call(c,'foundry_list_combats'),scenes:await call(c,'foundry_list_scenes'),fog:await Promise.all([gmId,userId].map(userId=>call(c,'foundry_get_scene_fog',{sceneId,userId})))};
 };
 report.before=await capture();
 if(report.before.token.light.negative||report.before.token.light.angle!==360||report.before.token.light.darkness.min>report.before.scene.darkness||report.before.token.light.darkness.max<report.before.scene.darkness)throw Error('Existing native light configuration requires review');
 writeFileSync('docs/prompt4-token-light-live.json',JSON.stringify(report,null,2));
 const traceId=randomUUID(),input={worldId:'izzy-campaign',userId:gmId,requestId:randomUUID(),correlationId:randomUUID(),sceneId,tokenId,light:{bright:20,dim:40}};
 const start=performance.now();
 const raw=await c.callTool({name:'foundry_set_token_light',arguments:input,_meta:{'foundry-ai-dungeon-master/trace-id':traceId}});
 let result=raw.structuredContent??JSON.parse(raw.content.find(v=>v.type==='text').text);for(let i=0;i<4&&result?.data;i++)result=result.data;
 report.action={traceId,input,receipt:result,roundTripMs:performance.now()-start};
 writeFileSync('docs/prompt4-token-light-live.json',JSON.stringify(report,null,2));
 if(raw.isError||result.outcome!=='confirmed')throw Error('Light action not confirmed; stop without retry');
 report.after=await capture();
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const withoutLight=t=>{const copy=structuredClone(t);delete copy.light;return copy;};
 const beforeScene=structuredClone(report.before.scene),afterScene=structuredClone(report.after.scene);for(const s of [beforeScene,afterScene])delete s.tokens.find(t=>(t._id??t.id)===tokenId).light;
 report.comparison={tokenExceptLight:same(withoutLight(report.before.token),withoutLight(report.after.token)),sceneExceptLight:same(beforeScene,afterScene),...Object.fromEntries(['actor','views','automaticEvents','pause','combats','scenes'].map(k=>[k,same(report.before[k],report.after[k])])),bright:report.after.token.light.bright===20,dim:report.after.token.light.dim===40};
 report.fogComparison=same(report.before.fog,report.after.fog);report.fogScope='Original scene fog was never cleared or restored; native illumination may update exploration.';
 writeFileSync('docs/prompt4-token-light-live.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({outcome:result.outcome,mutated:result.mutated,light:result.state.light,comparison:report.comparison,fogUnchanged:report.fogComparison,roundTripMs:report.action.roundTripMs,traceId}));
} catch(e){report.error=e.message;writeFileSync('docs/prompt4-token-light-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify({error:e.message,actionOutcome:report.action?.receipt?.outcome}));process.exitCode=1;}finally{await c.close();}
