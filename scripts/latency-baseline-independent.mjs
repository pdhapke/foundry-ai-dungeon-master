import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {StreamableFoundryLocalApiMcpClient} from '../server/dist/integrations/foundry-local-api-mcp.js';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const env=require('dotenv').parse(readFileSync(new URL('../../foundry-local-api/server/.env',import.meta.url)));
const client=new StreamableFoundryLocalApiMcpClient({baseUrl:'http://127.0.0.1:3939',apiKey:env.API_KEY??env.FOUNDRY_API_KEY,clientVersion:'0.1.0'});
try {
 const status=await client.callTool({name:'foundry_get_status',arguments:{},idempotencyKey:null});
 const caps=await client.callTool({name:'foundry_get_capability_report',arguments:{},idempotencyKey:null});
 const fixture=JSON.parse(readFileSync(new URL('../docs/core-rollout-evidence/live-fixture.json',import.meta.url)));
 const call=(name,args={})=>client.callTool({name,arguments:args,idempotencyKey:null});
 const automaticEventsEnabled=await call('foundry_get_setting',{namespace:'foundry-ai-dungeon-master',key:'automaticEventsEnabled'});
 writeFileSync(new URL('../docs/latency-baseline-independent-automatic.json',import.meta.url),JSON.stringify({capturedAt:new Date().toISOString(),automaticEventsEnabled},null,2));
 console.log(JSON.stringify({automaticEventsEnabled}));
 const fixtureState={scene:await call('foundry_get_scene',{id:fixture.sceneId}),actor:await call('foundry_get_actor',{id:fixture.actorId}),combat:await call('foundry_get_combat',{id:fixture.combatId}),pause:await call('foundry_get_game_paused'),scenes:await call('foundry_list_scenes'),combats:await call('foundry_list_combats')};
 writeFileSync(new URL('../docs/latency-baseline-independent-fixture.json',import.meta.url),JSON.stringify({capturedAt:new Date().toISOString(),fixture,state:fixtureState},null,2));
 console.log('Read-only fixture and original active/pause/combat state captured.');
 writeFileSync(new URL('../docs/latency-baseline-independent-mcp.json',import.meta.url),JSON.stringify({capturedAt:new Date().toISOString(),status,capabilities:caps},null,2));
 console.log(JSON.stringify({status,clientSummary:caps.clients.map(({clientId,lane,optedIn,isGM,systemVersion})=>({clientId,lane,optedIn,isGM,systemVersion}))}));
} catch {console.log('Authenticated inspection failed; details suppressed.'); process.exitCode=1;} finally {await client.close();}







