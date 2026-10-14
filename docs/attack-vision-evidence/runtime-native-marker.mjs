import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
config({path:'../foundry-local-api/server/.env',quiet:true});
const fixture=JSON.parse(readFileSync('docs/attack-vision-evidence/live-fixture.json','utf8').replace(/^\uFEFF/,''));
const client=new Client({name:'readonly-loaded-build-validator',version:'1'});
const transport=new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3939/mcp'),{requestInit:{headers:{authorization:`Bearer ${process.env.FOUNDRY_API_KEY}`}}});
try {
 await client.connect(transport);
 const response=await client.callTool({name:'foundry_core_state',arguments:{worldId:fixture.worldId,userId:fixture.userId,schemaVersion:'core-actions-v1'}});
 let value=response.structuredContent;
 if (!value) value=JSON.parse(response.content.find(item=>item.type==='text').text);
 for(let i=0;i<4;i++){if(value?.movementPolicy) break;value=value?.data??value?.result??value;}
 const record={capturedAt:new Date().toISOString(),gate:!response.isError&&value?.movementPolicy==='native-constrained-walk-v1'&&value?.schemaVersion==='core-actions-v1'?'PASS':'FAIL',schemaVersion:value?.schemaVersion??null,movementPolicy:value?.movementPolicy??null,fixtureSceneMatches:value?.scene?.id===fixture.sceneId,scope:'Actual authenticated native coreState bridge read; source marker, not browser rendering acceptance.'};
 writeFileSync('docs/attack-vision-evidence/runtime-native-marker.json',JSON.stringify(record,null,2));
 console.log(JSON.stringify(record));
} finally {await client.close();}
