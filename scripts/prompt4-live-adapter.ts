/** Model-free production adapter rehearsal. Does not start servers or mutate Foundry. */
import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { StreamableFoundryLocalApiMcpClient } from "../server/src/integrations/foundry-local-api-mcp.js";
import { ChatKitReadTools } from "../server/src/chatkit/read-tools.js";
import { TrustedToolCatalog, FoundryLocalApiProviderAdapter, CHATKIT_READ_TOOL_METADATA } from "../server/src/tool-catalog/index.js";
import type { AiDmAuthenticatedIdentity } from "@foundry-ai-dungeon-master/shared";

config({path:"server/.env",quiet:true});
config({path:"../foundry-local-api/server/.env",quiet:true});
const key = process.env["FOUNDRY_LOCAL_API_KEY"] ?? process.env["FOUNDRY_API_KEY"];
if (!key) throw new Error("Configured MCP authentication unavailable");
const [sceneId, tokenId, playerId = "edtBL96Yu3058QAT", playerClientId = "80f7f865-6ebf-4a83-ad44-33ab0c0747f2"] = process.argv.slice(2);
const operation = process.argv[6] ?? "token_perception";
if (!["token_perception", "player_surroundings"].includes(operation)) throw new Error("Choose token_perception or player_surroundings");
if (!sceneId || !tokenId) throw new Error("Pass approved sceneId and owned tokenId");
const client = new StreamableFoundryLocalApiMcpClient({baseUrl:process.env["FOUNDRY_LOCAL_API_URL"] ?? "http://127.0.0.1:3939",apiKey:key,clientVersion:"prompt4-model-free"});
const calls: {name:string; arguments:unknown; startedAt:string; durationMs:number; outcome:string}[]=[];
const call = async (name:string,args:Record<string,string>={}) => {
  const started = performance.now(), startedAt = new Date().toISOString();
  try { const value=await client.callTool({name,arguments:args,idempotencyKey:null},{timeout:10000,maxTotalTimeout:10000}); calls.push({name,arguments:args,startedAt,durationMs:performance.now()-started,outcome:"returned"}); return value as any; }
  catch { calls.push({name,arguments:args,startedAt,durationMs:performance.now()-started,outcome:"failed"}); throw new Error("Live authorized read failed"); }
};
try {
  const world=await call("foundry_get_world"), caps=await call("foundry_get_capability_report");
  const gm=caps.clients?.find((v:any)=>v.isGM===true&&v.lane==="gm"&&v.optedIn===true);
  if (!gm) throw new Error("Authenticated GM command lane unavailable");
  const identity:AiDmAuthenticatedIdentity={worldId:world._id??world.id,userId:gm.userId,clientId:gm.clientId,lane:"gm",isGm:true};
  const authorize=async () => {
    const [w,u,s]=await Promise.all([call("foundry_get_world"),call("foundry_get_user_by_id",{userId:identity.userId}),call("foundry_get_user_status",{userId:identity.userId})]);
    if((w._id??w.id)!==identity.worldId||(u._id??u.id)!==identity.userId||s.userId!==identity.userId||s.active!==true||!(u.isGM===true||Number(u.role)>=4)) throw new Error("Current Foundry GM authorization required");
  };
  const traced={listTools:()=>client.listTools(),callTool:async (r:any,o:any)=>{
    const started=performance.now(),startedAt=new Date().toISOString();
    try {const value=await client.callTool(r,o);calls.push({name:r.name,arguments:r.arguments,startedAt,durationMs:performance.now()-started,outcome:"returned"});return value;}
    catch(e){calls.push({name:r.name,arguments:r.arguments,startedAt,durationMs:performance.now()-started,outcome:"failed"});throw e;}
  }};
  const catalog=new TrustedToolCatalog(new FoundryLocalApiProviderAdapter({client:traced,providerVersion:"live"}),CHATKIT_READ_TOOL_METADATA,"prompt4-live");
  await catalog.refresh();
  const adapter=new ChatKitReadTools(traced,authorize,catalog,{internalSecret:randomBytes(32).toString("hex")});
  const signal=new AbortController().signal,run=adapter.begin(identity,{params:{thread_id:"prompt4-model-free"}},signal);
  try {
    const scope={worldId:identity.worldId,userId:identity.userId,threadId:"prompt4-model-free"};
    const cases=[];
    for(const [label,userId,clientId] of [["selected-player",playerId,playerClientId],["gm-substitution",gm.userId,gm.clientId]]) {
      const started=performance.now();
      const result=await adapter.execute(run.token,scope,operation,{sceneId,tokenId,effectiveUserId:userId!,clientId:clientId!},signal);
      cases.push({label,result,adapterMs:performance.now()-started});
    }
    const evidence={capturedAt:new Date().toISOString(),operation,scope:"Current source ChatKitReadTools + production authenticated MCP transport. Not loaded AI HTTP route, Python or embedded chat; no narration or browser assertion.",identity,cases,calls,inferenceRequests:0,mutations:0};
    writeFileSync("docs/prompt4-live-adapter-evidence.json",JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({cases:cases.map(v=>({label:v.label,result:v.result})),inferenceRequests:0,mutations:0}));
  } finally {run.release();}
} finally {await client.close();}
