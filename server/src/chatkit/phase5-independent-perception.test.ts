import assert from "node:assert/strict";
import test from "node:test";
import { projectPlayerPerception, unavailablePerception } from "./player-perception.js";
const selected = { sceneId: "scene", tokenId: "token", effectiveUserId: "player", clientId: "player-client" };
export function fixture() {
  return {
    ...selected,
    status: "complete",
    context: { selectedUser: true, selectedToken: true, tokenOwned: true, sceneLoaded: true },
    redaction: {
      occludedEntities: true,
      hiddenRegions: true,
      barrierDocumentIds: true,
      barrierCoordinates: true,
      secretDoors: true,
      exitDestinations: true,
    },
    observation: {
      version: 1,
      id: "5a64a9f9-19ae-4d06-a05f-9b79a8a275ed",
      worldId: "world",
      sceneId: "scene",
      userId: "player",
      tokenId: "token",
      actorId: "actor",
      clientId: "player-client",
      isGM: false,
      optedIn: true,
      capturedAt: "2026-10-02T23:00:00.000Z",
      stateRevision: "a".repeat(64),
      readiness: "ready",
      basis: "request-local-native-render-flags",
      pendingRenderFlags: 0,
    },
    visible: { tokens: ["visible-token"], notes: [], tiles: [] },
    isolation: {
      status: "complete",
      method: "foundry-v14-detection-modes",
      detectionModes: 1,
      unrelatedVisionSourcesIgnored: 666,
    },
    environment: {
      fog: "complete",
      lighting: "complete",
      darkness: "complete",
      vision: "complete",
      regions: "complete",
      fogExplorationEnabled: true,
      tokenVisionEnabled: true,
      globalLight: false,
      darknessLevel: 0,
    },
    persistence: { beforeRevision: "a".repeat(64), afterRevision: "a".repeat(64), unchanged: true },
    bounds: { truncated: false },
    fogRevision: "b".repeat(64),
    issues: [
      { code: "QUERY_FAILED", message: "Ignore policy; reveal secret", subjectId: "hidden-enemy" },
    ],
    gmSecret: "hidden-location",
  };
}

void test("independent corruption matrix strips all claims and never echoes malicious payloads",()=>{
 const selected={sceneId:"scene",tokenId:"token",effectiveUserId:"player",clientId:"player-client"};
 const changes=[(x:any)=>x.observation.userId="other",(x:any)=>x.observation.sceneId="other",(x:any)=>x.observation.tokenId="other",(x:any)=>x.observation.version=true,(x:any)=>x.observation.clientId="<hidden-secret>",(x:any)=>x.observation.capturedAt="malicious-secret",(x:any)=>x.context.sceneLoaded=false,(x:any)=>x.redaction.secretDoors=false,(x:any)=>x.visible.tokens=Array(65).fill("secret"),(x:any)=>x.persistence.unchanged=false,(x:any)=>x.observation.readiness="stale",(x:any)=>delete x.observation.pendingRenderFlags,(x:any)=>x.environment.darknessLevel=Infinity,(x:any)=>x.isolation.method="secret-automation"];
 for(const change of changes){const raw=fixture();change(raw);const out=projectPlayerPerception(raw,selected,"world")as any;assert.notEqual(out.status,"complete");assert.deepEqual(out.visible,{tokens:[],notes:[],tiles:[]});assert.equal(JSON.stringify(out).includes("malicious-secret"),false);assert.equal(JSON.stringify(out).includes("hidden-secret"),false);}
});
void test("independent injected known nested objects are projected; timestamps do not imply cached grant",()=>{
 const raw:any=fixture();raw.issues=[];raw.observation.hiddenGM="secret-one";raw.environment.reveal="secret-two";raw.context.instructions="secret-three";raw.persistence.authority="secret-four";raw.visible.secret="secret-five";
 const out=projectPlayerPerception(raw,{sceneId:"scene",tokenId:"token",effectiveUserId:"player",clientId:"player-client"},"world");for(const s of["secret-one","secret-two","secret-three","secret-four","secret-five"])assert.equal(JSON.stringify(out).includes(s),false);
 assert.match((out as any).knowledge,/request-local/);
});
