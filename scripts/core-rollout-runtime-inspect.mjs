import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {StreamableFoundryLocalApiMcpClient} from '../server/dist/integrations/foundry-local-api-mcp.js';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const env=require('dotenv').parse(readFileSync(new URL('../../foundry-local-api/server/.env',import.meta.url)));
const client=new StreamableFoundryLocalApiMcpClient({baseUrl:'http://127.0.0.1:3939',apiKey:env.API_KEY??env.FOUNDRY_API_KEY,clientVersion:'0.1.0'});
try {
 const status=await client.callTool({name:'foundry_get_status',arguments:{},idempotencyKey:null});
 const caps=await client.callTool({name:'foundry_get_capability_report',arguments:{},idempotencyKey:null});
 writeFileSync(new URL('../docs/core-rollout-evidence/runtime-current.json',import.meta.url),JSON.stringify({capturedAt:new Date().toISOString(),status,capabilities:caps},null,2));
 console.log(JSON.stringify({status,capabilities:caps}));
} catch {console.log('Authenticated inspection failed; details suppressed.'); process.exitCode=1;} finally {await client.close();}

