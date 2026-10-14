import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditUniformGrid, geometryMigrationImpact, PreparationJobService } from '../server/src/preparation-jobs/index.js';
import { CampaignRetrieval } from '../server/src/preparation/retrieval.js';
import { WorldCampaignContext } from '../server/src/context/world-campaign.js';

test('independent nine-case campaign evaluation reports exact expected retrieval',()=>{
 const specs=[['quest','Starting quest','Recover the lighthouse key.'],['motivation','NPC motivation','Warden Mara protects her missing brother.'],['location','Location details','North harbor has two stone piers.'],['event','Unresolved event','The courier vanished; fate unknown.'],['relationship','Cross record','Mara serves the Harbor faction.'],['corrected','Corrected fact','The bell rings at sunset, corrected from noon.'],['rumor','Rumor','Rumor: a ghost ship waits offshore.'],['trap','Private trap','Needle trap detection DC 14; activation remains manual.']];
 const records=specs.map(([id,title,text])=>({schemaVersion:1,id,worldId:'evaluation',kind:id==='quest'?'quest':'lore',title,aliases:[],revision:1,visibility:id==='trap'?'gm':'player',status:'confirmed',epistemic:id==='rumor'?'rumor':'established',sources:[{uri:'campaign://evaluation/fixture.md',hash:'a'.repeat(64),startLine:1,endLine:2}],relationships:id==='relationship'?[{id:'motivation',relation:'about'}]:[],sections:[{heading:title,text}],unknowns:[],contradictions:[],generated:false}));
 const retrieval=new CampaignRetrieval('evaluation',records as any,()=>{});const wording=['lighthouse','brother','stone piers','courier vanished','serves','sunset','ghost','needle'];const cases=[...specs.map(([id],i)=>({query:wording[i]!,expected:[id!],audience:id==='trap'?'gm':'player'})),{query:'unsupported dragon ancestry',expected:[],audience:'player'}];
 const evidence=cases.map(c=>{const started=performance.now();const result=retrieval.search({worldId:'evaluation',audience:c.audience as 'gm'|'player'},c.query);const latencyMilliseconds=performance.now()-started;const retrieved=[...new Set(result.hits.map(h=>h.id))];assert.deepEqual(retrieved,c.expected);return {...c,retrieved,latencyMilliseconds,bytes:result.bytes};});
 assert.deepEqual(retrieval.search({worldId:'evaluation',audience:'player'},'trap').hits,[]);assert.equal(retrieval.related({worldId:'evaluation',audience:'player'},'relationship')[0]?.id,'motivation');
 console.log(JSON.stringify({evaluation:'nine-case-model-free',records:records.length,sections:records.length,indexSourceBytes:Buffer.byteLength(JSON.stringify(records)),indexType:'disposable in-memory section index',secrecyFailures:0,missingExpectedRecords:0,cases:evidence}));
});

test('independent opposite-edge calibration rejects distortion and preserves geometry',()=>{
 const points=[{artworkX:10,artworkY:20,gridColumn:0,gridRow:0},{artworkX:910,artworkY:20,gridColumn:9,gridRow:0},{artworkX:10,artworkY:920,gridColumn:0,gridRow:9},{artworkX:910,artworkY:920,gridColumn:9,gridRow:9}];
 const result=auditUniformGrid(points,1000,1000,0.01);assert.equal(result.uniformSpacing,100);assert.equal(result.originX,10);assert.equal(result.originY,20);assert.equal(result.uniformAlignmentAccepted,true);assert.equal(result.tvAcceptance,'pending');
 assert.equal(auditUniformGrid(points.map((p,i)=>i===3?{...p,artworkX:930}:p),1000,1000,1).uniformAlignmentAccepted,false);
 assert.throws(()=>auditUniformGrid(points.slice(0,3).map(p=>({...p,artworkX:p.artworkX/10,artworkY:p.artworkY/10})),1000,1000,1));
 const geometry=[{kind:'trap' as const,x:50,y:100},{kind:'door' as const,x:900,y:900}];const saved=structuredClone(geometry);const migration=geometryMigrationImpact(geometry,{scale:2,offsetX:10,offsetY:-10});assert.deepEqual(geometry,saved);assert.equal(migration.applied,false);assert.equal(migration.points[0]?.proposedX,110);
});
test('independent bounded jobs isolate worlds, stop cancelled work and fence stale resume',()=>{
 const data=new Map();let current={area:'r1'};const jobs=new PreparationJobService({read:k=>data.has(k)?structuredClone(data.get(k)):undefined,write:(j,expected)=>{assert.equal(data.get(j.id)?.revision??null,expected);data.set(j.id,structuredClone(j));}},{authorize:()=>{},currentSourceRevisions:()=>current});
 const caller={worldId:'one',isGm:true};const input={worldId:'one',requestId:'req',areaIds:['area'],sourceRevisions:{area:'r1'},depth:'outline' as const,maxAreas:1,desiredReadiness:'records' as const};const job=jobs.create(caller,input);assert.equal(jobs.create(caller,input).id,job.id);assert.throws(()=>jobs.status({worldId:'two',isGm:true},job.id));assert.throws(()=>jobs.status({...caller,isGm:false},job.id));jobs.cancel(caller,job.id);assert.throws(()=>jobs.prepareAreas(caller,job.id,[{id:'area',revision:'r1',title:'Area',entryPoints:[],travelLinks:[],encounterRecordIds:[]}]));current={area:'r2'};assert.throws(()=>jobs.resume(caller,job.id));assert.equal(jobs.status(caller,job.id).spending.requests,0);
});
test('independent record retrieval removes private relationships/provenance and preserves whole sections',()=>{
 const base={schemaVersion:1,id:'public',worldId:'one',kind:'place',title:'Gateway',aliases:['Gate'],revision:1,visibility:'player',status:'confirmed',epistemic:'established',sources:[{uri:'campaign://one/private-name.md',hash:'a'.repeat(64),startLine:1,endLine:2}],relationships:[{id:'secret',relation:'conceals'}],sections:[{heading:'Condition',text:'Opens only at dawn. At night the lock remains sealed.'}],unknowns:[],contradictions:[],generated:false};const hidden={...base,id:'secret',visibility:'gm',relationships:[],sections:[{heading:'Secret',text:'invisible needle trap'}]};const retrieval=new CampaignRetrieval('one',[base,hidden] as any,()=>{});const caller={worldId:'one',audience:'player' as const};assert.deepEqual(retrieval.related(caller,'public'),[]);const search=retrieval.search(caller,'Gate');assert.equal(search.hits[0]?.excerpt,base.sections[0]?.text);assert.deepEqual(search.hits[0]?.sources,[]);assert.ok(!JSON.stringify(search).includes('private-name'));assert.equal(retrieval.read(caller,'secret'),null);assert.equal(retrieval.search(caller,'needle').hits.length,0);assert.ok(Buffer.byteLength(JSON.stringify(retrieval.search(caller,'Gate',{maxCharacters:512})))<=512);
});
test('independent legacy player metadata unaffected by private source additions',()=>{
 const root=mkdtempSync(join(tmpdir(),'prompt2-independent-'));const campaign=join(root,'one/data/campaign');mkdirSync(campaign,{recursive:true});const principal={clientId:'fixture',lane:'player',userId:'player',worldId:'one',isGm:false,role:1,connectionId:'c',authorizedAudienceKinds:['public'],permissionSnapshotRevision:'p'} as any;
 try {const context=new WorldCampaignContext(root);const before=context.retrieve(principal,'unsupported',null);writeFileSync(join(campaign,'private-mystery.md'),'---\nschema_version: 1\nid: secret\nrevision: r1\nvisibility: gm\ncanon_status: canon\n---\n## GM-ONLY\nSecret.');assert.deepEqual(context.retrieve(principal,'unsupported',null),before);} finally {rmSync(root,{recursive:true,force:true});}
});



