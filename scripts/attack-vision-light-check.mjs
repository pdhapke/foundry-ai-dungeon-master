import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {StreamableFoundryLocalApiMcpClient} from '../server/dist/integrations/foundry-local-api-mcp.js';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const env=require('dotenv').parse(readFileSync(new URL('../../foundry-local-api/server/.env',import.meta.url)));
const client=new StreamableFoundryLocalApiMcpClient({baseUrl:'http://127.0.0.1:3939',apiKey:env.API_KEY??env.FOUNDRY_API_KEY,clientVersion:'0.1.0'});
const fixture=JSON.parse(readFileSync(new URL('../docs/attack-vision-evidence/live-fixture.json',import.meta.url),'utf8'));
const mode=process.argv[2];
const call=(name,args)=>client.callTool({name,arguments:args,idempotencyKey:null});
try {
 const status=await call('foundry_get_status',{});
 if(status.worldId!==fixture.worldId||status.userId!==fixture.userId)throw Error('Fixture scope mismatch');
 let result;
 if(mode==='local')result=await call('foundry_update_scene',{id:fixture.sceneId,changes:{'environment.globalLight.enabled':false}});
 else if(mode==='dark'||mode==='lit')result=await call('foundry_update_scene_light',{sceneId:fixture.sceneId,placeableId:fixture.lightId,changes:{hidden:mode==='dark'}});
 else throw Error('Unsupported light fixture mode');
 const record={mode,at:new Date().toISOString(),sceneId:fixture.sceneId,confirmed:!!result};
 writeFileSync(new URL('../docs/attack-vision-evidence/live-light-'+mode+'.json',import.meta.url),JSON.stringify(record,null,2));
 console.log(JSON.stringify(record));
}catch(error){console.log(JSON.stringify({mode,result:'failed',message:error instanceof Error?error.message:'unknown'}));process.exitCode=1;}finally{await client.close();}
