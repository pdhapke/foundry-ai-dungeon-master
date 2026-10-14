import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./player-perception.test.js";
import { projectPlayerSurroundings } from "./player-perception.js";
import type { PlayerDescriptionPlan } from "../context/world-campaign.js";
const selected={sceneId:"scene",tokenId:"token",effectiveUserId:"player",clientId:"player-client"};
const plan:PlayerDescriptionPlan={sourceRevision:"c".repeat(64),points:[{id:"description-1",x:10,y:20,elevation:0}],descriptions:[{queryId:"description-1",description:"A blue lantern hangs at this point.",nodeId:"d".repeat(64),revision:"e".repeat(64)}]};
function observation() {return {...fixture(),visibleBarriers:[{key:"barrier-1",kind:"door",state:"closed",blocksVision:true,exit:true,destination:"redacted"}],queryPoints:[{id:"description-1",visible:true,regions:[],blockerAttribution:"none",blockerKeys:[]}]};}
void test("native visible barriers and exact public point produce bounded deterministic facts",()=>{
  const raw=observation();Object.assign(raw,{privateNote:"SECRET_TRAP",trapCoordinates:[12,45],secretDoor:"SECRET_DOOR"});
  const result=projectPlayerSurroundings(raw,selected,"world",plan) as any;
  assert.equal(result.status,"ready");assert.equal(result.facts.length,2);
  assert.equal(result.facts[0].description,"A closed door is visible.");
  assert.equal(result.facts[1].description,"A blue lantern hangs at this point.");
  assert.doesNotMatch(JSON.stringify(result),/SECRET|barrier-1|description-1|destination|coordinates/);
  assert.deepEqual(result.unknowns,["threat","being-noticed","trap","unobserved-area"]);
});
void test("occluded or uncertain query cannot activate public area description",()=>{
  for(const change of [(raw:any)=>raw.queryPoints[0].visible=false,(raw:any)=>raw.queryPoints[0].blockerAttribution="environment-ambiguous",(raw:any)=>raw.queryPoints[0].id="other",(raw:any)=>raw.queryPoints.push({...raw.queryPoints[0]})]) {
    const raw=observation();change(raw);const result=projectPlayerSurroundings(raw,selected,"world",plan) as any;
    assert.equal(result.facts.length,1);assert.equal(result.facts[0].kind,"visible-door");
  }
});
void test("missing malformed native barrier evidence fails rather than synthesize descriptions",()=>{
  for(const change of [(raw:any)=>delete raw.visibleBarriers,(raw:any)=>raw.visibleBarriers[0].key="secret-door-id",(raw:any)=>raw.redaction.secretDoors=false,(raw:any)=>raw.observation.clientId="gm-client"]) {
    const raw=observation();change(raw);const result=projectPlayerSurroundings(raw,selected,"world",plan) as any;
    assert.notEqual(result.status,"ready");assert.deepEqual(result.facts,[]);
  }
});
void test("negative surroundings retains actionable connection and unsupported states",()=>{
  for(const [raw,expected] of [[{status:"unavailable",issues:[{code:"PLAYER_CLIENT_UNAVAILABLE",message:"SECRET"}]},"NOT_CONNECTED"],[{status:"unsupported"},"unsupported"],[{status:"stale"},"stale"]] as const) {
    const result=projectPlayerSurroundings(raw,selected,"world",plan) as any;
    assert.equal(result.status,expected);assert.deepEqual(result.facts,[]);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
  }
});
