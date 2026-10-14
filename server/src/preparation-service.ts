import { z } from 'zod';
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from '@foundry-ai-dungeon-master/shared';
import { CampaignStorage } from './context/campaign-storage.js';
import { CampaignSourceRepository } from './context/campaign-source.js';
import { worldCampaignRoot } from './context/world-campaign.js';
import type { ProtectedCampaignOptions } from './context/protected-campaign.js';
import { PreparationRecordStore, type PreparationCandidate } from './preparation/records.js';
import { CampaignRetrieval } from './preparation/retrieval.js';
import { FilePreparationJobStore, SqlitePreparationJobStore, PreparationJobService, type PreparationJobInput, type PreparationAreaSource, type PreparationMapCandidate, type PreparationPopulationProposal } from './preparation-jobs/index.js';
import { PREPARATION_OPERATIONS } from './chatkit/preparation-contract.js';
import { hashText } from './context/hash.js';
import type { DatabaseSync } from 'node:sqlite';
import { NativePreparationReviewQueue } from './preparation-jobs/native-adapter.js';
import { PreparationPublicationReviews } from './preparation/publication-review.js';
import { TrustedPreparationReviews } from './preparation/trusted-review.js';
import { PreparationSourceInventory } from './preparation/source-inventory.js';
import { sourceRecordDraftPackets } from './preparation/source-drafts.js';
import { composePreparationCandidates } from './preparation/record-composition.js';
import { archivePreparationInterview } from './preparation/interview-source.js';
import { DurableNativePreparationComposer } from './preparation-jobs/durable-native.js';
import { ExistingWorldDocumentPreparationTransport } from './preparation-jobs/world-native-transport.js';
import { importApprovedLocalMapAsset } from './preparation-jobs/local-asset-import.js';
import { planBattlemap } from './preparation-jobs/battlemap-plan.js';
import { ForestBattlemapWorkflow } from './preparation-jobs/forest-battlemap.js';
import { randomUUID } from 'node:crypto';
import type { AcceptanceFixture } from './config.js';
import { PreparationRequestError, preparationErrorCode, preparationPhaseEvent, markPreparationResult, type PreparationEffects, type PreparationPhase } from './preparation/outcome.js';
import { validateArguments, type FoundryLocalApiMcpClient } from './tool-catalog/index.js';
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';

const envelope = z.object({ operation: z.enum(PREPARATION_OPERATIONS), input: z.record(z.string(), z.unknown()) }).strict();
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const json = (value: unknown) => value as AiDmJsonValue;
export interface PreparationServiceOptions {
  worldsRoot: string; protectedCampaign: ProtectedCampaignOptions; jobsRoot: string;
  assertPrivateStorage(worldId: string): void;
  authorize(identity: AiDmAuthenticatedIdentity, signal: AbortSignal): Promise<void>;
  sidecarUrl: string; internalSecret: string; fetch?: typeof globalThis.fetch;
  database: DatabaseSync;
  mcpClient?: FoundryLocalApiMcpClient;
  acceptanceFixtures?: Readonly<Record<string,AcceptanceFixture>>;
}
/** Zero-provider entry; publication/native effects require an exact browser-only human decision. */
export class PreparationService {
  private readonly indexes = new Map<string, { revision: string; fingerprint:string; candidate:PreparationCandidate; retrieval: CampaignRetrieval }>();
  private readonly inventories = new Map<string, PreparationSourceInventory>();
  private readonly sourceHashes = new Map<string,{fingerprint:string;hash:string}>();
  constructor(private readonly options: PreparationServiceOptions) {}
  private async authorizePhase(identity:AiDmAuthenticatedIdentity,signal:AbortSignal,phase:PreparationPhase,effects:PreparationEffects='none'):Promise<void> {
    try { await this.options.authorize(identity,signal);signal.throwIfAborted();preparationPhaseEvent(phase,'returned'); }
    catch(error) { preparationPhaseEvent(phase,'error',error);throw new PreparationRequestError(phase,effects,preparationErrorCode(error),error); }
  }
  /** Exclusive process startup only, before accepting preparation requests. */
  recoverStartup(): void {
    const table=this.options.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='preparation_native_composition'").get();
    if(table)this.options.database.exec('UPDATE preparation_native_composition SET busy=0');
  }
  async execute(identity: AiDmAuthenticatedIdentity, raw: unknown, signal: AbortSignal, origin: 'browser' | 'dm' = 'dm'): Promise<AiDmJsonValue> {
    if (!identity.isGm) throw Error('Preparation unavailable');
    await this.authorizePhase(identity,signal,'service-initial-authorization');
    let parsed:z.infer<typeof envelope>;
    try {
      this.options.assertPrivateStorage(identity.worldId);
      if (Buffer.byteLength(JSON.stringify(raw)) > 28000) throw Error('Preparation input exceeds bound');
      parsed=envelope.parse(raw);
      if(parsed.input['worldId']!==undefined&&parsed.input['worldId']!==identity.worldId)throw Error('Preparation unavailable');
    } catch(error) { preparationPhaseEvent('operation','error',error);throw new PreparationRequestError('operation','none',preparationErrorCode(error),error); }
    const { operation, input } = parsed;
    const assertWorld = (worldId: string) => { signal.throwIfAborted(); if (worldId !== identity.worldId) throw Error('Preparation unavailable'); };
    const storage = new CampaignStorage(this.options.worldsRoot, { authorize: assertWorld, assertPrivateStorage: this.options.assertPrivateStorage }, 128000, 512000, this.options.protectedCampaign);
    const sourceHash = (worldId: string, uri: string): string | null => {
      assertWorld(worldId);
      const match = /^campaign:\/\/([A-Za-z0-9_-]+)\/(.+)$/.exec(uri);
      if (!match || match[1] !== worldId) throw Error('Invalid source provenance');
      const repository = new CampaignSourceRepository([{ rootId: worldId, path: worldCampaignRoot(this.options.protectedCampaign.protectedRoot, worldId) }]);
      try {
        const fingerprint=storage.fingerprint(worldId,[match[2]!]),cached=this.sourceHashes.get(uri);
        if(cached?.fingerprint===fingerprint)return cached.hash;
        const hash=repository.load(worldId,match[2]!).sourceHash;
        if(storage.fingerprint(worldId,[match[2]!])!==fingerprint)throw Error('Source changed during read');
        if(this.sourceHashes.size>=512)this.sourceHashes.clear();this.sourceHashes.set(uri,{fingerprint,hash});return hash;
      } catch { return null; }
    };
    const reviewer = { worldId: identity.worldId, userId: identity.userId, clientId: identity.clientId, isGm: identity.isGm };
    const reviews = new PreparationPublicationReviews(this.options.database, current => assertWorld(current.worldId));
    const trustedReviews = new TrustedPreparationReviews(this.options.database, current => assertWorld(current.worldId));
    const records = new PreparationRecordStore(storage, (worldId,candidateId) => { assertWorld(worldId); reviews.assertApproved(reviewer,candidateId); }, sourceHash);
    const retrieve = (rebuild = false) => {
      const key = identity.worldId;
      const prior = this.indexes.get(key);
      const revision=records.activeRevision(key);
      if(!revision)return null;
      if(!rebuild&&prior?.revision===revision&&prior.fingerprint===records.fingerprint(key,prior.candidate))return prior.retrieval;
      const active = records.active(key);
      if (!active) return null;
      records.assertCompanionsCurrent(key,active.candidate);
      const retrieval = new CampaignRetrieval(key, active.candidate.records, caller => {if(caller.worldId!==key)throw Error('Preparation unavailable');});
      if (this.indexes.size >= 8 && !this.indexes.has(key)) this.indexes.clear();
      this.indexes.set(key, { revision: active.revision, fingerprint:records.fingerprint(key,active.candidate),candidate:active.candidate,retrieval });
      return retrieval;
    };
    let result: unknown;
    let effects:PreparationEffects='none';
    if(['job-create','job-stage','job-cancel','job-resume','job-review-package','job-native-review','job-native-apply','map-local-import'].includes(operation)
      ||(operation==='interview'&&['create','answer','pause','resume'].includes(String(input['operation'])))
      ||(operation==='pipeline'&&['create','submit','pause','resume','cancel'].includes(String(input['operation']))))effects='unknown';
    const stageCandidate=(candidate:PreparationCandidate)=>{
      effects='unknown';const receipt=records.stage(candidate);effects='committed';return receipt;
    };
    try {
    if (['template','interview','pipeline','validate-output','build-request'].includes(operation)) {
      const action = operation === 'template' ? 'template' : operation === 'interview' ? 'interview' : operation === 'pipeline' ? 'pipeline' : operation === 'validate-output' ? 'validate' : 'request';
      const payload: Record<string, unknown> = { ...input, action };
      delete payload['sourcePaths'];
      if (origin === 'dm' && action === 'interview' && input['operation'] === 'answer') { Object.assign(payload, { approved: false }); }
      if (action === 'request' || action === 'validate' || (action === 'pipeline' && ['create','submit'].includes(String(input['operation'])))) {
        const inputs = z.record(z.string(), z.unknown()).parse(input['inputs']);
        if (inputs['worldId'] !== identity.worldId) throw Error('Preparation unavailable');
        const paths = z.array(z.object({ id: identifier, path: z.string().min(1).max(200), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict()).max(32).parse(input['sourcePaths'] ?? []);
        if (!paths.length && z.array(z.unknown()).parse(inputs['sources'] ?? []).length) throw Error('Actual protected source bindings required');
        if (new Set(paths.map(p => p.id)).size !== paths.length) throw Error('Duplicate source identifiers');
        const repository = new CampaignSourceRepository([{ rootId: identity.worldId, path: worldCampaignRoot(this.options.protectedCampaign.protectedRoot, identity.worldId) }]);
        const sources = paths.map(p => {
          const source = repository.load(identity.worldId, p.path);
          if (source.sourceHash !== p.expectedRevision) throw Error('Source revision conflict');
          const span = repository.readSource(source.sourceUri, { startLine: p.startLine, endLine: p.endLine });
          return { id: p.id, revision: source.sourceHash, content: span.text, visibility: 'gm', sourceUri: source.sourceUri, startLine: p.startLine, endLine: p.endLine };
        });
        payload['inputs'] = { ...inputs, sources };
      }
      const response = await (this.options.fetch ?? globalThis.fetch)(new URL('/preparation', this.options.sidecarUrl), {
        method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-chatkit-secret': this.options.internalSecret,
          'x-chatkit-principal': Buffer.from(JSON.stringify({ worldId: identity.worldId, userId: identity.userId, isGm: true })).toString('base64') }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw Error('Invalid preparation request or stale interview');
      const text = await response.text(); if (Buffer.byteLength(text) > 28000) throw Error('Preparation output exceeds bound');
      result = JSON.parse(text);
      if(action==='interview'&&input['operation']==='answer'&&result&&typeof result==='object') {
        const session=(result as Record<string,unknown>)['session'];
        if(session&&typeof session==='object'&&'world_id' in session) {
          if((session as Record<string,unknown>)['session_id']!==input['sessionId'])throw Error('Interview source identity conflict');
          await this.options.authorize(identity,signal);signal.throwIfAborted();
          effects='unknown';archivePreparationInterview(storage,identity.worldId,identity.userId,session);effects='committed';
        }
      }
      if (result && typeof result === 'object' && 'untrustedInput' in result) {
        const request = z.record(z.string(), z.unknown()).parse((result as Record<string, unknown>)['untrustedInput']);
        for (const source of z.array(z.record(z.string(), z.unknown())).parse(request['sources'] ?? []))
          if (typeof source['sourceUri'] === 'string' && sourceHash(identity.worldId, source['sourceUri']) !== source['revision']) throw Error('Stored preparation source is stale');
      }
    } else if (operation === 'source-inventory' || operation === 'source-read' || operation === 'record-prepare') {
      let inventory=this.inventories.get(identity.worldId);
      if(!inventory) {
        if(this.inventories.size>=8)this.inventories.clear();
        const worldId=identity.worldId;
        inventory=new PreparationSourceInventory(worldId,worldCampaignRoot(this.options.protectedCampaign.protectedRoot,worldId),current=>{if(current.worldId!==worldId)throw Error('Preparation unavailable');});
        this.inventories.set(identity.worldId,inventory);
      }
      const caller={worldId:identity.worldId,audience:'gm' as const};
      if(operation==='source-inventory') {
        const page=z.object({cursor:z.string().max(80).optional(),limit:z.number().int().min(1).max(32).optional(),refresh:z.boolean().optional()}).strict().parse(input);
        result=inventory.list(caller,{...(page.cursor===undefined?{}:{cursor:page.cursor}),...(page.limit===undefined?{}:{limit:page.limit}),...(page.refresh===undefined?{}:{refresh:page.refresh})});
      }
      else if(operation==='source-read') {
        const request=z.object({path:z.string().min(1).max(200),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional()}).strict().parse(input);
        const source=inventory.load(caller,[request.path])[0]!;
        const repository=new CampaignSourceRepository([{rootId:identity.worldId,path:worldCampaignRoot(this.options.protectedCampaign.protectedRoot,identity.worldId)}],{maxSourceCharacters:6000,maxSourceLines:100});
        const span=repository.readSource(source.sourceUri,{startLine:request.startLine??1,endLine:request.endLine??Math.min(30,source.text.split('\n').length)});
        if(span.sourceHash!==source.sourceHash)throw Error('Source revision conflict');
        result={sourceUri:source.sourceUri,revision:source.sourceHash,span,sourceBytes:Buffer.byteLength(source.text),visibility:'gm'};
      } else {
        const request=z.object({candidateId:z.string().regex(/^[A-Za-z0-9_-]{1,56}$/),sources:z.array(z.object({path:z.string().min(1).max(200),expectedRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(31),interviewSessionId:identifier.optional()}).strict().parse(input);
        if(!request.sources.length&&!request.interviewSessionId)throw Error('Explicit preparation sources required');
        const sources=request.sources.length?inventory.load(caller,request.sources.map(s=>s.path)):[];
        for(const source of sources)if(request.sources.find(s=>s.path===source.relativePath)?.expectedRevision!==source.sourceHash)throw Error('Source revision conflict');
        let interviewSource:ReturnType<typeof archivePreparationInterview>|null=null;
        if(request.interviewSessionId) {
          const response=await(this.options.fetch??globalThis.fetch)(new URL('/preparation',this.options.sidecarUrl),{method:'POST',signal,headers:{'content-type':'application/json','x-chatkit-secret':this.options.internalSecret,'x-chatkit-principal':Buffer.from(JSON.stringify({worldId:identity.worldId,userId:identity.userId,isGm:true})).toString('base64')},body:JSON.stringify({action:'interview',sessionId:request.interviewSessionId,operation:'read'})});
          if(!response.ok)throw Error('Interview unavailable');const text=await response.text();if(Buffer.byteLength(text)>28000)throw Error('Interview source bound');
          const payload=z.record(z.string(),z.unknown()).parse(JSON.parse(text));
          if(z.record(z.string(),z.unknown()).parse(payload['session'])['session_id']!==request.interviewSessionId)throw Error('Interview source identity conflict');
          await this.options.authorize(identity,signal);signal.throwIfAborted();
          effects='unknown';interviewSource=archivePreparationInterview(storage,identity.worldId,identity.userId,payload['session']);effects='committed';
          sources.push(new CampaignSourceRepository([{rootId:identity.worldId,path:worldCampaignRoot(this.options.protectedCampaign.protectedRoot,identity.worldId)}]).load(identity.worldId,interviewSource.path));
        }
        const prepared=sourceRecordDraftPackets(identity.worldId,request.candidateId,sources);
        if(interviewSource)for(const candidate of prepared.packets) {
          const uri=`campaign://${identity.worldId}/${interviewSource.watermarkPath}`;
          const record=candidate.records.find(r=>r.sources.some(source=>source.uri===`campaign://${identity.worldId}/${interviewSource!.path}`)&&r.kind!=='overview'&&r.kind!=='index');
          if(record){record.sources.push({uri,hash:interviewSource.watermarkHash,startLine:1,endLine:8});candidate.manifest[uri]=interviewSource.watermarkHash;}
        }
        const baseRevision=records.active(identity.worldId)?.revision??null;
        const candidates=prepared.packets.map(candidate=>({...candidate,baseRevision}));
        // Validate every packet's storage budget before staging any of them.
        if(candidates.some(candidate=>Buffer.byteLength(JSON.stringify(candidate))>120000))throw Error('Selected record packet needs narrower scope');
        result={status:'private-record-drafts',sourceCount:sources.length,modelCalls:0,publicationApproved:false,
          candidates:candidates.map(candidate=>({candidateId:candidate.candidateId,recordCount:candidate.records.length,receipt:stageCandidate(candidate)})),
          unknowns:['Partial selected-source packets; explicit review is required. Publishing a packet replaces the active retrieval version, not the original sources.']};
      }
    } else if(operation==='candidate-compose') {
      const request=z.object({candidateId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),packetIds:z.array(identifier).min(1).max(16),overviewPacketId:identifier.optional()}).strict().parse(input);
      const candidate=composePreparationCandidates(records,identity.worldId,request.candidateId,request.packetIds,request.overviewPacketId);
      for(const path of ['overview.md','index.md']){
        const uri=`campaign://${identity.worldId}/${path}`,hash=sourceHash(identity.worldId,uri);
        if(hash)candidate.manifest[uri]=hash;else delete candidate.manifest[uri];
      }
      result={status:'private-composed-draft',candidateId:candidate.candidateId,recordCount:candidate.records.length,receipt:stageCandidate(candidate),publicationApproved:false,preservesActiveRecords:true};
    } else if (operation === 'candidate-review' || operation === 'candidate-review-read' || operation === 'candidate-confirm' || operation === 'candidate-publish') {
      const candidateId=identifier.parse(input['candidateId']);
      if(operation==='candidate-review') {
        result=reviews.stage(reviewer,candidateId,records,storage,z.number().int().min(0).max(256).parse(input['offset']??0));
        if(['completed','rejected'].includes((result as {status:string}).status))effects='committed';
      }
      else if(operation==='candidate-review-read') result=reviews.read(reviewer,candidateId,identifier.parse(input['recordId']),z.number().int().min(0).max(39).parse(input['section']??0),z.number().int().min(0).max(16000).parse(input['offset']??0));
      else if(operation==='candidate-confirm') {
        if(origin!=='browser')throw Error('Explicit authenticated GM browser confirmation required');
        result=reviews.confirm(reviewer,candidateId,z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(input['newCandidateId']),z.string().regex(/^[a-f0-9]{64}$/).parse(input['reviewDigest']),origin,records,storage);
        effects='committed';
      }
      else {
        if(origin!=='browser')throw Error('Explicit authenticated GM browser decision required');
        await this.authorizePhase(identity,signal,'publication-pre-dispatch-authorization');
        result=reviews.decide(reviewer,candidateId,z.string().regex(/^[a-f0-9]{64}$/).parse(input['reviewDigest']),z.enum(['approve','reject']).parse(input['decision']),origin,records,storage);
        effects='committed';
        this.indexes.delete(identity.worldId);
      }
    } else if (['battlemap-import','battlemap-prepare','battlemap-review','battlemap-apply','battlemap-status','battlemap-display','battlemap-acceptance','battlemap-generation-request','battlemap-generation-status','battlemap-generation-complete'].includes(operation)) {
      const client=this.options.mcpClient;if(!client)throw Error('FOREST_MCP_UNAVAILABLE');
      if(['battlemap-import','battlemap-prepare','battlemap-review','battlemap-apply','battlemap-display','battlemap-generation-request','battlemap-generation-complete'].includes(operation))effects='unknown';
      result=await new ForestBattlemapWorkflow({database:this.options.database,jobsRoot:this.options.jobsRoot,publicDataRoot:this.options.protectedCampaign.publicDataRoot,client,
        authorize:this.options.authorize,assertPrivateStorage:this.options.assertPrivateStorage,...(this.options.acceptanceFixtures?{acceptanceFixtures:this.options.acceptanceFixtures}:{})}).execute(identity,operation,input,signal,origin);
      if(effects==='unknown')effects='committed';
    } else if (operation === 'battlemap-plan') {
      if(identity.worldId!=='mcp-test')throw Error('BATTLEMAP_TEST_WORLD_REQUIRED');
      const request=z.object({worldId:z.literal('mcp-test'),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),imageWidth:z.number().int(),imageHeight:z.number().int()}).strict().parse(input);
      const table=this.options.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='preparation_asset_receipts'").get();
      if(!table)throw Error('BATTLEMAP_APPROVED_ASSET_REQUIRED');
      const row=this.options.database.prepare('SELECT body FROM preparation_asset_receipts WHERE world_id=? AND source_hash=?').get(identity.worldId,request.sourceHash) as {body:string}|undefined;
      if(!row)throw Error('BATTLEMAP_APPROVED_ASSET_REQUIRED');
      const receipt=JSON.parse(row.body) as {assetRef:string};
      const client=this.options.mcpClient;if(!client)throw Error('BATTLEMAP_MCP_UNAVAILABLE');
      const call=async(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:json(args),idempotencyKey:null},{signal,timeout:5000}) as Promise<Record<string,unknown>>;
      const world=await call('foundry_get_world');if(world['id']!==identity.worldId)throw Error('BATTLEMAP_WORLD_CHANGED');
      const caps=await call('foundry_get_capability_report');
      const tv=(caps['clients'] as Array<{clientId:string;userId:string;lane:string;optedIn:boolean}>).filter(c=>c.lane==='tv'&&c.optedIn);
      if(tv.length!==1)throw Error('BATTLEMAP_EXACT_AUTHENTICATED_TV_REQUIRED');
      const user=await call('foundry_get_user_by_id',{userId:tv[0]!.userId});
      if(user['name']!=='TV'||user['role']!==2)throw Error('BATTLEMAP_TV_ROLE_MISMATCH');
      const correlationId=`forest-plan-${randomUUID()}`;
      const ack=await call('foundry_get_client_readiness',{clientId:tv[0]!.clientId,userId:tv[0]!.userId,correlationId,minimumModuleVersion:'0.1.0'});
      const display=ack['display'] as {cssWidth:number;cssHeight:number;devicePixelRatio:number;canvasReady:boolean}|undefined;
      if(ack['correlationId']!==correlationId||ack['executingClientId']!==tv[0]!.clientId||ack['clientUserId']!==tv[0]!.userId||ack['replayed']!==false||ack['sceneReady']!==true||ack['incomplete']!==false||display?.canvasReady!==true)throw Error('BATTLEMAP_FRESH_TV_DISPLAY_REQUIRED');
      await this.options.authorize(identity,signal);if((await call('foundry_get_world'))['id']!==identity.worldId)throw Error('BATTLEMAP_WORLD_CHANGED');
      result=planBattlemap({...request,name:'Forest — TV calibration fixture',assetRef:receipt.assetRef,displayWidthMm:955,display:{clientId:tv[0]!.clientId,userName:'TV',role:2,cssWidth:display.cssWidth,cssHeight:display.cssHeight,devicePixelRatio:display.devicePixelRatio,sceneReady:true}});
    } else if (operation === 'map-local-import') {
      if(origin!=='browser')throw Error('Explicit authenticated GM browser asset approval required');
      const request=z.object({worldId:identifier,sourcePath:z.string().max(1000),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),license:z.string().min(1).max(2000),playerVisibleApproved:z.literal(true)}).strict().parse(input);
      if(request.worldId!==identity.worldId)throw Error('Preparation unavailable');
      await this.options.authorize(identity,signal);signal.throwIfAborted();
      const approvedSourceRoot=join(this.options.jobsRoot,'local-assets',identity.worldId,'incoming');
      const mapsRoot=join(this.options.protectedCampaign.publicDataRoot,'ai-dm-prepared-maps');
      if(realpathSync(this.options.protectedCampaign.publicDataRoot)!==resolve(this.options.protectedCampaign.publicDataRoot))throw Error('Public artwork root redirect forbidden');
      if(existsSync(mapsRoot)&&(lstatSync(mapsRoot).isSymbolicLink()||realpathSync(mapsRoot)!==resolve(mapsRoot)))throw Error('Public artwork destination redirect forbidden');
      const publicAssetRoot=join(mapsRoot,identity.worldId);
      // A reviewed raster import is the only preparation operation creating public artwork.
      mkdirSync(publicAssetRoot,{recursive:true});
      result=importApprovedLocalMapAsset(request,{worldId:identity.worldId,approvedSourceRoot,publicAssetRoot,publicUrlPrefix:`ai-dm-prepared-maps/${identity.worldId}`,authorize:()=>assertWorld(identity.worldId)});
      this.options.database.exec('CREATE TABLE IF NOT EXISTS preparation_asset_receipts(world_id TEXT NOT NULL, source_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(world_id,source_hash))');
      this.options.database.prepare('INSERT INTO preparation_asset_receipts(world_id,source_hash,body) VALUES(?,?,?) ON CONFLICT(world_id,source_hash) DO UPDATE SET body=excluded.body').run(identity.worldId,request.sourceHash,JSON.stringify({userId:identity.userId,clientId:identity.clientId,sourcePath:request.sourcePath,...result as Record<string,unknown>}));
    } else if (operation === 'candidate-stage') {
      const candidate = input as unknown as PreparationCandidate;
      if (candidate.worldId !== identity.worldId) throw Error('Preparation unavailable');
      for (const [uri, revision] of Object.entries(candidate.manifest)) if (sourceHash(identity.worldId, uri) !== revision) throw Error('Source revision conflict');
      result = { status: 'private-candidate-staged', receipt: stageCandidate(candidate), publicationApproved: false };
    } else if (operation === 'index-rebuild') {
      result = { status: retrieve(true) ? 'rebuilt' : 'no-published-version', generatedContent: false };
    } else if(operation==='record-revisions') {
      const ids=z.array(identifier).min(1).max(32).parse(input['ids']);
      const retrieval=retrieve();const active=retrieval?this.indexes.get(identity.worldId)?.candidate:undefined;
      result={candidateId:records.activeRevision(identity.worldId)?active?.candidateId??null:null,revisions:Object.fromEntries(ids.map(id=>{const record=active?.records.find(r=>r.id===id);return[id,record?hashText(JSON.stringify(record)):null];})),unknown:!active};
    } else if (operation.startsWith('record')) {
      const retrieval = retrieve(), caller = { worldId: identity.worldId, audience: 'gm' as const };
      result = !retrieval ? { status: 'no-published-version', hits: [], unknown: true } : operation === 'records-search'
        ? retrieval.search(caller, z.string().min(1).max(200).parse(input['query']), z.object({ limit: z.number().int().optional(), offset: z.number().int().optional(), maxCharacters: z.number().int().optional() }).strict().parse(input['bounds'] ?? {}))
        : operation === 'record-read' ? retrieval.read(caller, identifier.parse(input['id']), z.object({ offset: z.number().int().optional(), maxCharacters: z.number().int().optional() }).strict().parse(input['bounds'] ?? {})) : retrieval.related(caller, identifier.parse(input['id']));
    } else {
      const jobStore=new SqlitePreparationJobStore(this.options.database,new FilePreparationJobStore({protectedRoot:this.options.jobsRoot,publicDataRoot:this.options.protectedCampaign.publicDataRoot}));
      const boundJob=operation==='job-create'?null:jobStore.read(identifier.parse(input['jobId']));
      if(boundJob&&boundJob.input.worldId!==identity.worldId)throw Error('Preparation unavailable');
      const sourceIds=operation==='job-create'?Object.keys(z.record(z.string(),z.unknown()).parse(input['sourceRevisions'])):Object.keys(boundJob?.input.sourceRevisions??{});
      if(sourceIds.length>64)throw Error('Preparation source bound');
      const currentSourceRevisions = (worldId: string) => {
          assertWorld(worldId);retrieve();
          const active=this.indexes.get(worldId)?.candidate;
          if (!active || !records.activeRevision(worldId)) return {};
          const selected=active.records.filter(record=>sourceIds.includes(record.id));
          const refs=new Map(selected.flatMap(record=>record.sources).map(source=>[source.uri,source.hash]));
          for (const [uri, revision] of refs) {
            if(['overview.md','index.md'].some(path=>uri===`campaign://${worldId}/${path}`))continue;
            if(sourceHash(worldId,uri)!==revision)throw Error('Source revision conflict');
          }
          records.assertCompanionsCurrent(worldId,active);
          return Object.fromEntries(selected.map(record => [record.id, hashText(JSON.stringify(record))]));
        };
      const jobs = new PreparationJobService(jobStore, {
        authorize: caller => assertWorld(caller.worldId), currentSourceRevisions,
      });
      const caller = { worldId: identity.worldId, isGm: true };
      if (operation === 'job-create') result = jobs.create(caller, input as unknown as PreparationJobInput);
      else {
        const key = identifier.parse(input['jobId']);
        if (['job-review-package','job-native-review','job-native-apply','job-native-status'].includes(operation)) {
          const queue = new NativePreparationReviewQueue(this.options.database, {
            authorize: current => assertWorld(current.worldId), assertPrivateStorage: () => this.options.assertPrivateStorage(identity.worldId), currentSourceRevisions,
            authorizeHumanReview: (approvalId,digest) => trustedReviews.assert(reviewer,approvalId,digest,'native'),
          });
          const authority={authorize:(current:typeof caller)=>assertWorld(current.worldId),assertPrivateStorage:()=>this.options.assertPrivateStorage(identity.worldId),currentSourceRevisions,
            authorizeHumanReview:(approvalId:string,digest:string)=>trustedReviews.assert(reviewer,approvalId,digest,'native')};
          if(operation==='job-review-package')result=queue.stage(caller,jobs.status(caller,key),identifier.parse(input['areaId']));
          else {
            const packageId=z.string().regex(/^[a-f0-9]{64}$/).parse(input['packageId']);
            const pkg=queue.get(caller,packageId);
            const job=jobs.status(caller,key);
            if(pkg.jobId!==job.id||pkg.inputRevision!==job.revision||job.state==='paused'||job.state==='cancelled')throw Error('Native preparation job changed');
            const assertCurrentJob=()=>{
              const current=jobs.status(caller,key);
              if(current.revision!==pkg.inputRevision||current.state==='paused'||current.state==='cancelled')throw Error('Native preparation job changed');
            };
            authority.authorizeHumanReview=(approvalId,digest)=>{assertCurrentJob();trustedReviews.assert(reviewer,approvalId,digest,'native');};
            if(operation==='job-native-review') {
              if(origin!=='browser'||input['decision']!=='approve'||input['reviewDigest']!==pkg.digest)throw Error('Exact authenticated GM browser review required');
              const approvalId=trustedReviews.approve(reviewer,pkg.digest,'native',origin);
              result={approvalId,package:queue.review(caller,packageId,approvalId),applied:false};
            } else {
              if(operation==='job-native-apply'&&origin!=='browser')throw Error('Explicit authenticated GM browser apply request required');
              const client=this.options.mcpClient;if(!client)throw Error('Native preparation transport unavailable');
              const transport=new ExistingWorldDocumentPreparationTransport({worldId:identity.worldId,userId:identity.userId,
                authorize:async()=>{await this.options.authorize(identity,signal);signal.throwIfAborted();assertWorld(identity.worldId);assertCurrentJob();},
                call:async(name,args)=>{
                  const tools=await client.listTools();signal.throwIfAborted();
                  const schema=tools.find(tool=>tool.name===name)?.inputSchema;
                  if(!schema||validateArguments(schema,json(args)).length)throw Error('Native preparation capability schema unavailable');
                  const response=await client.callTool({name,arguments:json(args),idempotencyKey:null},{signal,timeout:10000,maxTotalTimeout:10000});
                  if(!response||typeof response!=='object'||Array.isArray(response)||Buffer.byteLength(JSON.stringify(response))>30000)throw Error('Invalid native preparation response');
                  return response as Record<string,unknown>;
                }});
              const composer=new DurableNativePreparationComposer(this.options.database,authority,transport);
              const compact=(value:ReturnType<typeof composer.status>)=>!value?{status:'not-applied'}:{packageId:value.packageId,worldId:value.worldId,state:value.state,sceneId:value.sceneId??null,readiness:value.readiness,steps:value.steps.map(entry=>({stepId:entry.step.id,verified:entry.receipt?.verified??false,targetId:entry.receipt?.targetId??null}))};
              if(operation==='job-native-status')result=compact(composer.status(caller,packageId));
              else {
                if(origin!=='browser')throw Error('Explicit authenticated GM browser apply request required');
                const approvalId=z.string().uuid().parse(input['approvalId']);
                try { result=compact(await composer.compose(caller,pkg,approvalId)); }
                catch(error) {
                  const message=error instanceof Error?error.message:'';
                  const reason=signal.aborted?'interrupted':/job changed/.test(message)?'job-changed':/source/i.test(message)?'source-changed':/readback|fields|disappeared|scene changed/i.test(message)?'native-state-changed':/capability|schema/i.test(message)?'capability-unavailable':'native-review-required';
                  result={status:'partial-or-needs-review',reason,result:compact(composer.status(caller,packageId)),ready:false};
                }
              }
            }
          }
        } else if (operation === 'job-status') result = jobs.status(caller, key);
        else if (operation === 'job-cancel') result = jobs.cancel(caller, key);
        else if (operation === 'job-resume') result = jobs.resume(caller, key);
        else {
          const proposals = z.array(z.unknown()).max(8).parse(input['proposals']);
          if (input['stage'] === 'area') result = jobs.prepareAreas(caller, key, proposals as PreparationAreaSource[]);
          else if (input['stage'] === 'map') result = jobs.prepareMaps(caller, key, proposals as PreparationMapCandidate[]);
          else if (input['stage'] === 'population') result = jobs.preparePopulation(caller, key, proposals as PreparationPopulationProposal[]);
          else throw Error('Unsupported preparation stage');
        }
      }
    }
    } catch(error) {
      preparationPhaseEvent('operation','error',error);
      if(error instanceof PreparationRequestError)throw error;
      throw new PreparationRequestError('operation',effects,preparationErrorCode(error),error);
    }
    preparationPhaseEvent('operation','returned');
    await this.authorizePhase(identity,signal,'service-final-authorization',effects);
    if (Buffer.byteLength(JSON.stringify(result)) > 28000) throw new PreparationRequestError('operation',effects,'INVALID_PAYLOAD');
    return json(markPreparationResult({ schemaVersion: 1, worldId: identity.worldId, trust: 'untrusted-source-data', narrationAllowed: false, modelCalls: 0, result },effects));
  }
}
