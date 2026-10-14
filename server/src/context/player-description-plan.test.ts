import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
import { WorldCampaignContext } from "./world-campaign.js";
const principal: AiDmRunPrincipal = { worldId:"world",userId:"gm",clientId:"gm-client",lane:"gm",isGm:true,role:4,connectionId:"run",authorizedAudienceKinds:["gm"],permissionSnapshotRevision:"fresh" };
const metadata = "---\nschema_version: 1\nid: POINT-PUBLIC\nrevision: 1\nvisibility: public\ncanon_status: canon\nfoundry_scene_id: scene\nobservation_scope: point\nobservation_x: 200\nobservation_y: 300\nobservation_elevation: 0\n---\n";
function fixture() { const root=mkdtempSync(join(tmpdir(),"player-description-")),campaign=join(root,"world","data","campaign");mkdirSync(campaign,{recursive:true});return {root,campaign,context:new WorldCampaignContext(root),close:()=>rmSync(root,{recursive:true,force:true})}; }
void test("public canonical point descriptions reuse visibility policy without private sections or metadata",()=>{
  const f=fixture();try {
    writeFileSync(join(f.campaign,"point.md"),metadata+"# PRIVATE_TITLE\n## PLAYER-VISIBLE\nA blue lantern hangs here.\n## OBSERVABLE\nA stone arch is visible at this point.\n## DISCOVERABLE\nSECRET_TRAP\n## GM-ONLY\nSECRET_MONSTER\n");
    const plan=f.context.playerDescriptionPlan(principal,"scene");
    assert.equal(plan.points.length,1);assert.equal(plan.descriptions.length,2);
    assert.doesNotMatch(JSON.stringify(plan),/SECRET|PRIVATE_TITLE|POINT-PUBLIC|source:|campaign:\/\/|\.md/);
    assert.deepEqual(plan.points[0],{id:"description-1",x:200,y:300,elevation:0});
    assert.equal(f.context.playerDescriptionPlan(principal,"other").descriptions.length,0);
  }finally{f.close();}
});
void test("scene membership, legacy metadata, private draft and missing elevation cannot authorize prose",()=>{
  const f=fixture();try {
    const changes=[metadata.replace("visibility: public","visibility: gm"),metadata.replace("canon_status: canon","canon_status: draft"),metadata.replace("observation_scope: point\n",""),metadata.replace("observation_elevation: 0\n",""),metadata.replace("schema_version: 1\n","")];
    for(const [index,value] of changes.entries())writeFileSync(join(f.campaign,`bad-${index}.md`),value+"## PLAYER-VISIBLE\nSECRET_UNAPPROVED\n");
    assert.equal(f.context.playerDescriptionPlan(principal,"scene").descriptions.length,0);
  }finally{f.close();}
});
void test("source change invalidates description receipt and source paths never enter description",()=>{
  const f=fixture();try {
    const path=join(f.campaign,"point.md");writeFileSync(path,metadata+"## PLAYER-VISIBLE\nA blue lantern hangs here.\n");
    const before=f.context.playerDescriptionPlan(principal,"scene");
    writeFileSync(path,metadata+"## PLAYER-VISIBLE\nA red lantern hangs here.\n");
    const after=f.context.playerDescriptionPlan(principal,"scene");assert.notEqual(before.sourceRevision,after.sourceRevision);
    writeFileSync(path,metadata+"## PLAYER-VISIBLE\n[Open private source](private.md)\n");assert.equal(f.context.playerDescriptionPlan(principal,"scene").descriptions.length,0);
    writeFileSync(path,metadata+"## PLAYER-VISIBLE\n# GM-ONLY\nSECRET\n");assert.equal(f.context.playerDescriptionPlan(principal,"scene").descriptions.length,0);
  }finally{f.close();}
});
