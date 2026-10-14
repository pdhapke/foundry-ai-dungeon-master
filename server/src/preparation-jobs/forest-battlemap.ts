import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from '@foundry-ai-dungeon-master/shared';
import type { FoundryLocalApiMcpClient } from '../tool-catalog/index.js';
import { validateArguments } from '../tool-catalog/index.js';
import { TrustedPreparationReviews } from '../preparation/trusted-review.js';
import { importApprovedLocalMapAsset } from './local-asset-import.js';
import { DurableNativePreparationComposer } from './durable-native.js';
import { ExistingWorldDocumentPreparationTransport } from './world-native-transport.js';
import type { NativePreparationReviewPackage } from './native-adapter.js';
import { planBattlemap } from './battlemap-plan.js';
import type { AcceptanceFixture } from '../config.js';

/** One explicitly approved disposable fixture. Neither model arguments nor discovered files expand it. */
export const FOREST_FIXTURE = Object.freeze({ worldId: 'mcp-test', name: 'Forest — TV calibration fixture',
  sourceHash: '1cbd027bde2f6c9fbfd3441805c51ef1fe8ad2619620909d2a593d55b860fd73',
  sourceWidth: 1254, sourceHeight: 1254, displayWidthMm: 955,
  license: 'User-approved ImageGen forest artwork; generated once for this test fixture; player-safe, gridless.' });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => value as AiDmJsonValue;
export class ForestBattlemapError extends Error {
  constructor(readonly code:string){super(code);this.name='ForestBattlemapError';}
}
async function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();let cancel=()=>{};
  const stopped=new Promise<never>((_,reject)=>{cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});});
  try{return await Promise.race([work,stopped]);}finally{signal.removeEventListener('abort',cancel);}
}
type ObjectValue = Record<string, unknown>;
type Profile = 'gm-preview' | 'tv';
interface StoredPackage { package: NativePreparationReviewPackage; profile: Profile; target: {clientId:string;userId:string}; display: {cssWidth:number;cssHeight:number}; viewport: {x:number;y:number;scale:number}; }
interface ForestFixture { worldId:string; name:string; sourceHash:string; sourceWidth:number; sourceHeight:number; displayWidthMm:number; license:string }
interface GenerationHandoff { id:string; worldId:string; userId:string; clientId:string; threadId:string; prompt:string; promptDigest:string; name:string; status:'needs-secure-generation-handoff'|'imported'; fixture?:ForestFixture; generationRef?:string }
export interface ForestBattlemapOptions {
  /** Trusted installation/test dependency, never accepted from tool or browser input. */
  fixture?: ForestFixture;
  database: DatabaseSync; jobsRoot: string; publicDataRoot: string; client: FoundryLocalApiMcpClient;
  authorize(identity: AiDmAuthenticatedIdentity, signal: AbortSignal): Promise<void>;
  assertPrivateStorage(worldId: string): void;
  acceptanceFixtures?: Readonly<Record<string,AcceptanceFixture>>;
}
/** Bounded source receipt -> native v14 package -> exact browser review -> durable CAS apply.
 * No provider requests or automatic scene activation. Model execution may only prepare/status. */
export class ForestBattlemapWorkflow {
  constructor(private readonly options: ForestBattlemapOptions) {}
  private get fixture() { return this.options.fixture ?? FOREST_FIXTURE; }
  private generationStorage() {
    this.options.database.exec('CREATE TABLE IF NOT EXISTS preparation_forest_generations(id TEXT PRIMARY KEY, world_id TEXT NOT NULL, body TEXT NOT NULL)');
  }
  private generation(identity:AiDmAuthenticatedIdentity,id:unknown):GenerationHandoff {
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new ForestBattlemapError('FOREST_GENERATION_ID_INVALID');
    this.generationStorage();
    const row=this.options.database.prepare('SELECT body FROM preparation_forest_generations WHERE id=? AND world_id=?').get(id,identity.worldId) as {body:string}|undefined;
    if(!row)throw new ForestBattlemapError('FOREST_GENERATION_UNAVAILABLE');
    const record=JSON.parse(row.body) as GenerationHandoff;
    if(record.userId!==identity.userId||record.clientId!==identity.clientId)throw new ForestBattlemapError('FOREST_GENERATION_OWNER_CHANGED');
    return record;
  }
  private saveGeneration(record:GenerationHandoff) {
    this.generationStorage();
    this.options.database.prepare('INSERT INTO preparation_forest_generations(id,world_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id,record.worldId,JSON.stringify(record));
  }
  private async generationOperation(identity:AiDmAuthenticatedIdentity,operation:string,input:ObjectValue,signal:AbortSignal,origin:'browser'|'dm') {
    const allowed=operation==='battlemap-generation-request'?['worldId','prompt','threadId','name']:['worldId','generationId','threadId'];
    if(input['worldId']!==identity.worldId||Object.keys(input).some(key=>!allowed.includes(key)))throw new ForestBattlemapError('FOREST_GENERATION_INPUT_INVALID');
    if(operation==='battlemap-generation-request') {
      const prompt=input['prompt'],threadId=input['threadId'],name=input['name'];
      if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000||typeof threadId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)||typeof name!=='string'||!name.trim()||name.length>120||name===FOREST_FIXTURE.name)throw new ForestBattlemapError('FOREST_GENERATION_INPUT_INVALID');
      // Deterministic within this authenticated request: retries cannot request another image.
      const id=hash([identity.worldId,identity.userId,identity.clientId,threadId,prompt,name]);
      this.generationStorage();
      const previous=this.options.database.prepare('SELECT body FROM preparation_forest_generations WHERE world_id=?').all(identity.worldId) as Array<{body:string}>;
      if(previous.some(row=>{const candidate=JSON.parse(row.body) as GenerationHandoff;return candidate.userId===identity.userId&&candidate.threadId===threadId&&candidate.id!==id;}))throw new ForestBattlemapError('FOREST_ONE_GENERATION_PER_THREAD');
      const existing=this.options.database.prepare('SELECT id FROM preparation_forest_generations WHERE id=?').get(id);
      if(!existing)this.saveGeneration({id,worldId:identity.worldId,userId:identity.userId,clientId:identity.clientId,threadId,prompt,promptDigest:hash(prompt),name,status:'needs-secure-generation-handoff'});
      const record=this.generation(identity,id);
      return {...record,generationIntegration:'unavailable',handoffRequired:record.status!=='imported',imageLimit:1,providerRequests:0,imagesImported:record.status==='imported'?1:0,imageInvocationsVerified:false,automaticGenerationAccepted:false,physicalAcceptance:false,
        nextAction:'Generate exactly one new player-safe gridless forest image through the approved secure ImageGen handoff. A trusted operator must stage matching PNG and receipt in the private generation incoming directory; browser completion imports it. Do not substitute an existing or externally fetched asset.'};
    }
    const record=this.generation(identity,input['generationId']);
    if(input['threadId']!==record.threadId)throw new ForestBattlemapError('FOREST_GENERATION_THREAD_CHANGED');
    if(operation==='battlemap-generation-status')return {...record,generationIntegration:'unavailable',handoffRequired:record.status!=='imported',imageLimit:1,providerRequests:0,imagesImported:record.status==='imported'?1:0,imageInvocationsVerified:false,automaticGenerationAccepted:false,physicalAcceptance:false};
    if(operation!=='battlemap-generation-complete'||origin!=='browser')throw new ForestBattlemapError('FOREST_GENERATION_BROWSER_COMPLETION_REQUIRED');
    if(record.status==='imported')return {...record,providerRequests:0,automaticGenerationAccepted:false,physicalAcceptance:false};
    // Paths are derived entirely from trusted storage and the recorded request ID.
    // No upload URL, source path, provider/key or receipt assertions are accepted from a model.
    const incoming=join(this.options.jobsRoot,'local-assets',identity.worldId,'generation-incoming');
    const receiptPath=join(incoming,`${record.id}.json`),sourcePath=join(incoming,`${record.id}.png`);
    for(const path of [incoming,receiptPath,sourcePath]) {
      if(!existsSync(path)||lstatSync(path).isSymbolicLink()||realpathSync(path)!==resolve(path))throw new ForestBattlemapError('FOREST_SECURE_GENERATION_RECEIPT_REQUIRED');
    }
    if(!lstatSync(receiptPath).isFile()||lstatSync(receiptPath).size>8000||!lstatSync(sourcePath).isFile()||lstatSync(sourcePath).size>32*1024*1024)throw new ForestBattlemapError('FOREST_GENERATION_RECEIPT_INVALID');
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8')) as ObjectValue;
    const bytes=readFileSync(sourcePath),sourceHash=createHash('sha256').update(bytes).digest('hex');
    if(receipt['requestId']!==record.id||receipt['promptDigest']!==record.promptDigest||receipt['integration']!=='secure-imagegen-handoff'||receipt['imageCount']!==1||receipt['sourceHash']!==sourceHash||sourceHash===FOREST_FIXTURE.sourceHash||receipt['playerVisibleApproved']!==true||typeof receipt['generationRef']!=='string'||!receipt['generationRef'].trim()||receipt['generationRef'].length>256||typeof receipt['license']!=='string'||!receipt['license'].trim()||receipt['license'].length>1000||bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new ForestBattlemapError('FOREST_GENERATION_RECEIPT_INVALID');
    const sourceWidth=bytes.readUInt32BE(16),sourceHeight=bytes.readUInt32BE(20);
    if(sourceWidth<320||sourceHeight<320||sourceWidth>8192||sourceHeight>8192||receipt['sourceWidth']!==sourceWidth||receipt['sourceHeight']!==sourceHeight)throw new ForestBattlemapError('FOREST_GENERATION_DIMENSIONS_INVALID');
    const prior=this.options.database.prepare('SELECT body FROM preparation_forest_generations WHERE world_id=?').all(identity.worldId) as Array<{body:string}>;
    if(prior.some(row=>{const previous=JSON.parse(row.body) as GenerationHandoff;return previous.id!==record.id&&(previous.fixture?.sourceHash===sourceHash||previous.generationRef===receipt['generationRef']);}))throw new ForestBattlemapError('FOREST_NEW_GENERATION_REQUIRED');
    const {assetRoot}=this.roots();mkdirSync(assetRoot,{recursive:true});
    const imported=importApprovedLocalMapAsset({worldId:identity.worldId,sourcePath,sourceHash,license:receipt['license'],playerVisibleApproved:true},{worldId:identity.worldId,approvedSourceRoot:incoming,publicAssetRoot:assetRoot,publicUrlPrefix:`ai-dm-prepared-maps/${identity.worldId}`,authorize:()=>{signal.throwIfAborted();this.options.assertPrivateStorage(identity.worldId);}});
    this.options.database.exec('CREATE TABLE IF NOT EXISTS preparation_asset_receipts(world_id TEXT NOT NULL, source_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(world_id,source_hash))');
    this.options.database.prepare('INSERT INTO preparation_asset_receipts(world_id,source_hash,body) VALUES(?,?,?) ON CONFLICT(world_id,source_hash) DO UPDATE SET body=excluded.body').run(identity.worldId,sourceHash,JSON.stringify({...imported,generationId:record.id,userId:identity.userId,clientId:identity.clientId}));
    await this.current(identity,signal);
    record.fixture={worldId:identity.worldId,name:`${record.name} - ${record.id.slice(0,12)}`,sourceHash,sourceWidth,sourceHeight,displayWidthMm:955,license:receipt['license']};
    record.generationRef=receipt['generationRef'];record.status='imported';this.saveGeneration(record);
    return {...record,providerRequests:0,automaticGenerationAccepted:false,physicalAcceptance:false,nextAction:'Prepare with this generationId and explicit tv profile; exact authenticated browser review/apply and fresh TV acknowledgements remain required.'};
  }
  private async current(identity: AiDmAuthenticatedIdentity, signal: AbortSignal) {
    signal.throwIfAborted();
    if(!identity.isGm || identity.lane !== 'gm' || identity.worldId !== this.fixture.worldId) throw new ForestBattlemapError('FOREST_TEST_GM_REQUIRED');
    this.options.assertPrivateStorage(identity.worldId);
    await this.options.authorize(identity,signal);
    const world = await this.call('foundry_get_world',{},signal);
    if(world['id']!==identity.worldId||world['title']!=='test mcp'||world['system']!=='dnd5e')throw new ForestBattlemapError('FOREST_WORLD_CHANGED');
  }
  private async call(name:string,args:ObjectValue,signal:AbortSignal):Promise<ObjectValue> {
    signal.throwIfAborted(); const schema=(await bounded(this.options.client.listTools(),signal)).find(t=>t.name===name)?.inputSchema;
    if(!schema||validateArguments(schema,json(args)).length)throw new ForestBattlemapError('FOREST_CAPABILITY_SCHEMA_UNAVAILABLE');
    const result=await bounded(this.options.client.callTool({name,arguments:json(args),idempotencyKey:null},{signal,timeout:5000,maxTotalTimeout:5000}),signal);
    if(!result||typeof result!=='object'||Array.isArray(result)||Buffer.byteLength(JSON.stringify(result))>30000)throw new ForestBattlemapError('FOREST_RESPONSE_INVALID');
    return result as ObjectValue;
  }
  private roots() {
    const sourceRoot=join(this.options.jobsRoot,'local-assets',this.fixture.worldId,'incoming');
    const mapsRoot=join(this.options.publicDataRoot,'ai-dm-prepared-maps');
    if(realpathSync(this.options.publicDataRoot)!==resolve(this.options.publicDataRoot))throw new ForestBattlemapError('FOREST_PUBLIC_ROOT_REDIRECT');
    if(existsSync(mapsRoot)&&(lstatSync(mapsRoot).isSymbolicLink()||realpathSync(mapsRoot)!==resolve(mapsRoot)))throw new ForestBattlemapError('FOREST_MAP_ROOT_REDIRECT');
    return {sourceRoot,mapsRoot,assetRoot:join(mapsRoot,this.fixture.worldId)};
  }
  private asset() {
    const table=this.options.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='preparation_asset_receipts'").get();
    if(!table)throw new ForestBattlemapError('FOREST_APPROVED_IMPORT_REQUIRED');
    const row=this.options.database.prepare('SELECT body FROM preparation_asset_receipts WHERE world_id=? AND source_hash=?').get(this.fixture.worldId,this.fixture.sourceHash) as {body:string}|undefined;
    if(!row)throw new ForestBattlemapError('FOREST_APPROVED_IMPORT_REQUIRED');
    const receipt=JSON.parse(row.body) as {assetRef:string;sourceHash:string};
    const expected=`ai-dm-prepared-maps/${this.fixture.worldId}/${this.fixture.sourceHash}.png`;
    if(receipt.assetRef!==expected||receipt.sourceHash!==this.fixture.sourceHash)throw new ForestBattlemapError('FOREST_ASSET_RECEIPT_MISMATCH');
    const {assetRoot}=this.roots(), path=join(assetRoot,`${this.fixture.sourceHash}.png`);
    if(realpathSync(assetRoot)!==resolve(assetRoot)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new ForestBattlemapError('FOREST_ASSET_REDIRECT');
    const bytes=readFileSync(path);
    if(bytes.length>32*1024*1024||createHash('sha256').update(bytes).digest('hex')!==this.fixture.sourceHash||bytes.readUInt32BE(16)!==this.fixture.sourceWidth||bytes.readUInt32BE(20)!==this.fixture.sourceHeight)throw new ForestBattlemapError('FOREST_ASSET_CHANGED');
    return receipt;
  }
  private storage() {
    this.options.database.exec('CREATE TABLE IF NOT EXISTS preparation_forest_packages(id TEXT PRIMARY KEY, world_id TEXT NOT NULL, body TEXT NOT NULL)');
  }
  private get(id:string):StoredPackage {
    if(!/^[a-f0-9]{64}$/.test(id))throw new ForestBattlemapError('FOREST_PACKAGE_INVALID');this.storage();
    const row=this.options.database.prepare('SELECT body FROM preparation_forest_packages WHERE id=? AND world_id=?').get(id,this.fixture.worldId) as {body:string}|undefined;
    if(!row)throw new ForestBattlemapError('FOREST_PACKAGE_UNAVAILABLE');
    const stored=JSON.parse(row.body) as StoredPackage;
    if(stored.package.sourceRevisions['asset']!==this.fixture.sourceHash)throw new ForestBattlemapError('FOREST_PACKAGE_FIXTURE_MISMATCH');
    return stored;
  }
  private async display(identity:AiDmAuthenticatedIdentity, profile:Profile, signal:AbortSignal) {
    if(profile==='tv') {
      const status=await this.call('dtt_get_status',{},signal);
      const settings=status['settings'] as {displayWidth?:number}|undefined;
      if(status['moduleActive']!==true||settings?.displayWidth!==this.fixture.displayWidthMm)throw new ForestBattlemapError('FOREST_DIGITAL_TABLETOP_955_MM_REQUIRED');
    }
    const report=await this.call('foundry_get_capability_report',{},signal);
    const clients=report['clients'] as Array<{clientId:string;userId:string;lane:string;optedIn:boolean;foundryVersion:string;systemId:string;systemVersion:string;protocolVersion:number;moduleVersion:string}>;
    // AI DM transport and companion bridge deliberately have separate client IDs.
    // Select exactly one authenticated companion for the same GM user; duplicates
    // fail closed. Persist that bridge ID and require fresh acknowledgements.
    const targets=clients.filter(c=>c.optedIn && (profile==='tv'?c.lane==='tv':c.lane==='gm'&&c.userId===identity.userId));
    if(targets.length!==1)throw new ForestBattlemapError(profile==='tv'?'FOREST_EXACT_TV_REQUIRED':'FOREST_EXACT_GM_REQUIRED');
    const target=targets[0]!;
    if(target.foundryVersion!=='14.368'||target.systemId!=='dnd5e'||target.systemVersion!=='6.0.3'||target.protocolVersion!==2||target.moduleVersion!=='0.1.0')throw new ForestBattlemapError('FOREST_CLIENT_CONTRACT_MISMATCH');
    const user=await this.call('foundry_get_user_by_id',{userId:target.userId},signal);
    if(profile==='tv'&&(user['name']!=='TV'||user['role']!==2))throw new ForestBattlemapError('FOREST_TV_ROLE_MISMATCH');
    if(profile==='gm-preview'&&user['role']!==4)throw new ForestBattlemapError('FOREST_GM_ROLE_MISMATCH');
    const correlationId=`forest-display-${randomUUID()}`;
    const ack=await this.call('foundry_get_client_readiness',{clientId:target.clientId,userId:target.userId,correlationId,minimumModuleVersion:'0.1.0'},signal);
    const display=ack['display'] as {cssWidth:number;cssHeight:number;devicePixelRatio:number;canvasReady:boolean;fullscreen?:boolean}|undefined;
    if(ack['acknowledged']!==true||ack['replayed']!==false||ack['correlationId']!==correlationId||ack['executingClientId']!==target.clientId||ack['clientUserId']!==target.userId||!display||!Number.isInteger(display.cssWidth)||!Number.isInteger(display.cssHeight)||display.cssWidth<320||display.cssHeight<320)throw new ForestBattlemapError('FOREST_FRESH_DISPLAY_REQUIRED');
    if(profile==='tv' && display.fullscreen!==true)throw new ForestBattlemapError('FOREST_TV_FULLSCREEN_REQUIRED');
    // Planning the new scene does not require a previous scene's preload contract.
    return {target,display};
  }
  private authority(identity:AiDmAuthenticatedIdentity,signal:AbortSignal) {
    const reviewer={...identity,isGm:true};
    const reviews=new TrustedPreparationReviews(this.options.database,current=>{signal.throwIfAborted();if(current.worldId!==identity.worldId||current.userId!==identity.userId||current.clientId!==identity.clientId)throw new ForestBattlemapError('FOREST_APPROVAL_SCOPE_CHANGED');});
    return {reviewer,reviews,authority:{authorize:(current:{worldId:string})=>{signal.throwIfAborted();if(current.worldId!==identity.worldId)throw new ForestBattlemapError('FOREST_WORLD_CHANGED');this.asset();},
      assertPrivateStorage:()=>this.options.assertPrivateStorage(identity.worldId),currentSourceRevisions:()=>({asset:this.asset().sourceHash}),
      authorizeHumanReview:(approvalId:string,digest:string)=>reviews.assert(reviewer,approvalId,digest,'native')}};
  }
  async execute(identity:AiDmAuthenticatedIdentity,operation:string,input:ObjectValue,signal:AbortSignal,origin:'browser'|'dm'):Promise<ObjectValue> {
    signal=AbortSignal.any([signal,AbortSignal.timeout(25000)]);
    await this.current(identity,signal);
    if(operation.startsWith('battlemap-generation-'))return this.generationOperation(identity,operation,input,signal,origin);
    if(input['generationId']!==undefined) {
      const record=this.generation(identity,input['generationId']);
      if(input['threadId']!==record.threadId)throw new ForestBattlemapError('FOREST_GENERATION_THREAD_CHANGED');
      if(record.status!=='imported'||!record.fixture)throw new ForestBattlemapError('FOREST_GENERATION_NOT_COMPLETE');
      if(!['battlemap-prepare','battlemap-review','battlemap-apply','battlemap-status','battlemap-display'].includes(operation))throw new ForestBattlemapError('FOREST_GENERATION_OPERATION_INVALID');
      const {generationId:_,...scopedInput}=input;
      return new ForestBattlemapWorkflow({...this.options,fixture:record.fixture}).execute(identity,operation,scopedInput,signal,origin);
    }
    if(Object.keys(input).some(key=>!['worldId','profile','packageId','reviewDigest','approvalId','threadId'].includes(key))||input['worldId']!==this.fixture.worldId)throw new ForestBattlemapError('FOREST_INPUT_INVALID');
    if(operation==='battlemap-acceptance') {
      if(origin!=='browser')throw new ForestBattlemapError('FOREST_BROWSER_BUDGET_BINDING_REQUIRED');
      const configured=Object.entries(this.options.acceptanceFixtures??{}).filter(([id,value])=>id.startsWith('forest-')&&value.worldId===identity.worldId&&value.userId===identity.userId&&value.threadId===input['threadId']&&Number.isInteger(value.maxModelRequests)&&value.maxModelRequests>=1&&value.maxModelRequests<=6&&Date.parse(value.expiresAt)>Date.now());
      if(configured.length!==1)throw new ForestBattlemapError('FOREST_APPROVED_BUDGET_NOT_CONFIGURED');
      const [fixtureId,binding]=configured[0]!;return {status:'budget-bound',fixtureId,...binding,providerRequests:0};
    }
    if(operation==='battlemap-import') {
      if(origin!=='browser')throw new ForestBattlemapError('FOREST_BROWSER_IMPORT_REQUIRED');
      const {sourceRoot,assetRoot}=this.roots();
      if(!existsSync(join(sourceRoot,`${this.fixture.sourceHash}.png`)))throw new ForestBattlemapError('FOREST_APPROVED_SOURCE_NOT_STAGED');
      mkdirSync(assetRoot,{recursive:true});
      const approval={worldId:this.fixture.worldId,sourcePath:join(sourceRoot,`${this.fixture.sourceHash}.png`),sourceHash:this.fixture.sourceHash,license:this.fixture.license,playerVisibleApproved:true as const};
      const receipt=importApprovedLocalMapAsset(approval,{worldId:identity.worldId,approvedSourceRoot:sourceRoot,publicAssetRoot:assetRoot,publicUrlPrefix:`ai-dm-prepared-maps/${identity.worldId}`,authorize:()=>{signal.throwIfAborted();this.options.assertPrivateStorage(identity.worldId);}});
      this.options.database.exec('CREATE TABLE IF NOT EXISTS preparation_asset_receipts(world_id TEXT NOT NULL, source_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(world_id,source_hash))');
      this.options.database.prepare('INSERT INTO preparation_asset_receipts(world_id,source_hash,body) VALUES(?,?,?) ON CONFLICT(world_id,source_hash) DO UPDATE SET body=excluded.body').run(identity.worldId,receipt.sourceHash,JSON.stringify({...receipt,userId:identity.userId,clientId:identity.clientId}));
      await this.current(identity,signal);return {status:'imported',...receipt,providerRequests:0};
    }
    if(operation==='battlemap-prepare') {
      const profile=input['profile'];if(profile!=='gm-preview'&&profile!=='tv')throw new ForestBattlemapError('FOREST_EXPLICIT_PROFILE_REQUIRED');
      const asset=this.asset(),{target,display}=await this.display(identity,profile,signal);
      const planned=planBattlemap({worldId:identity.worldId,name:this.fixture.name,assetRef:asset.assetRef,sourceHash:asset.sourceHash,imageWidth:this.fixture.sourceWidth,imageHeight:this.fixture.sourceHeight,displayWidthMm:955,profile,
        display:{clientId:target.clientId,userName:String(profile==='tv'?'TV':identity.userId),role:profile==='tv'?2:4,cssWidth:display.cssWidth,cssHeight:display.cssHeight,devicePixelRatio:display.devicePixelRatio,sceneReady:true}});
      const id=hash([this.fixture,profile,planned.scene]);
      const body={version:1 as const,id,worldId:identity.worldId,jobId:`forest-${asset.sourceHash.slice(0,24)}`,areaId:'forest',inputRevision:1,sourceRevisions:{asset:asset.sourceHash},state:'needs-native-contract' as const,
        sceneRequest:{toolId:'foundry_create_scene' as const,actionId:`forest-${id}`,expectedRevision:null,args:{data:{...planned.scene,tokens:[]}}},privateRecordLinks:{gmNoteRecordIds:[],trapRecordIds:[]},blockers:['Physical acceptance requires actual TV acknowledgement and ruler measurement.']};
      const pkg={...body,digest:hash(body)};
      // Foundry 14.368 default minimum zoom includes one grid cell around
      // the scene (board.mjs#getDimensions). A reviewed GM preview must not
      // request a lower scale that animatePan will silently clamp.
      const minimumPreviewScale=Math.min(display.cssWidth/(planned.scene.width+200),display.cssHeight/(planned.scene.height+200),1);
      const previewScale=Math.max(minimumPreviewScale,Math.min(display.cssWidth/planned.scene.width,display.cssHeight/planned.scene.height)*0.9);
      const stored:StoredPackage={package:pkg,profile,target:{clientId:target.clientId,userId:target.userId},display:{cssWidth:display.cssWidth,cssHeight:display.cssHeight},viewport:profile==='tv'?planned.viewport:{x:planned.scene.width/2,y:planned.scene.height/2,scale:previewScale}};
      this.storage();this.options.database.prepare('INSERT INTO preparation_forest_packages(id,world_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,identity.worldId,JSON.stringify(stored));
      const saved=this.get(id);if(saved.package.digest!==pkg.digest)throw new ForestBattlemapError('FOREST_PACKAGE_CONFLICT');
      await this.current(identity,signal);return {status:'needs-native-review',...saved,providerRequests:0,physicalAcceptance:false};
    }
    const stored=this.get(String(input['packageId'])),{package:pkg}=stored;
    const {reviews,reviewer,authority}=this.authority(identity,signal);
    if(operation==='battlemap-review') {
      if(origin!=='browser'||input['reviewDigest']!==pkg.digest)throw new ForestBattlemapError('FOREST_EXACT_BROWSER_REVIEW_REQUIRED');
      const approvalId=reviews.approve(reviewer,pkg.digest,'native','browser');pkg.state='reviewed';
      this.options.database.prepare('UPDATE preparation_forest_packages SET body=? WHERE id=? AND world_id=?').run(JSON.stringify(stored),pkg.id,identity.worldId);
      await this.current(identity,signal);return {status:'reviewed',approvalId,packageId:pkg.id,reviewDigest:pkg.digest,applied:false};
    }
    const transport=new ExistingWorldDocumentPreparationTransport({worldId:identity.worldId,userId:identity.userId,authorize:()=>this.current(identity,signal),call:(name,args)=>this.call(name,args,signal)});
    const composer=new DurableNativePreparationComposer(this.options.database,authority,transport);
    if(operation==='battlemap-status')return {status:'status',result:composer.status({worldId:identity.worldId,isGm:true},pkg.id)??null,profile:stored.profile,physicalAcceptance:false};
    if(operation==='battlemap-display') {
      if(origin!=='browser')throw new ForestBattlemapError('FOREST_BROWSER_DISPLAY_REQUIRED');
      const state=composer.status({worldId:identity.worldId,isGm:true},pkg.id);
      const receipt=state?.steps[0]?.receipt;if(state?.state!=='complete'||!state.sceneId||!receipt)throw new ForestBattlemapError('FOREST_CREATED_SCENE_REQUIRED');
      const scene=await transport.inspectScene(state.sceneId);
      if(scene.active||scene.preparationId!==pkg.id||scene.revision!==receipt.revision)throw new ForestBattlemapError('FOREST_SCENE_CHANGED');
      const fresh=await this.display(identity,stored.profile,signal);
      if(fresh.target.clientId!==stored.target.clientId||fresh.target.userId!==stored.target.userId||fresh.display.cssWidth!==stored.display.cssWidth||fresh.display.cssHeight!==stored.display.cssHeight)throw new ForestBattlemapError('FOREST_DISPLAY_CHANGED_REPREPARE_REQUIRED');
      const check=(ack:ObjectValue,correlationId:string)=>{if(ack['acknowledged']!==true||ack['replayed']!==false||ack['correlationId']!==correlationId||ack['executingClientId']!==stored.target.clientId||ack['clientUserId']!==stored.target.userId||ack['activeSceneId']!==state.sceneId)throw new ForestBattlemapError('FOREST_VIEW_NAMED_SCENE_FIRST');};
      let correlationId=`forest-view-${randomUUID()}`;
      if(stored.profile==='tv') {
        check(await this.call('foundry_apply_client_viewport',{...stored.target,correlationId,minimumModuleVersion:'0.1.0',sceneId:state.sceneId,viewport:stored.viewport,viewScene:true,digitalTabletop:true,timeoutMs:5000},signal),correlationId);
      } else check(await this.call('foundry_get_client_readiness',{...stored.target,correlationId,minimumModuleVersion:'0.1.0'},signal),correlationId);
      correlationId=`forest-preload-${randomUUID()}`;
      const preloaded=await this.call('foundry_preload_scene',{...stored.target,correlationId,minimumModuleVersion:'0.1.0',sceneId:state.sceneId,assetPaths:[this.asset().assetRef],timeoutMs:5000},signal);check(preloaded,correlationId);
      if(preloaded['sceneReady']!==true||preloaded['incomplete']!==false)throw new ForestBattlemapError('FOREST_PRELOAD_NOT_READY');
      await this.current(identity,signal);correlationId=`forest-viewport-${randomUUID()}`;
      const viewport=await this.call('foundry_apply_client_viewport',{...stored.target,correlationId,minimumModuleVersion:'0.1.0',sceneId:state.sceneId,viewport:stored.viewport,...(stored.profile==='tv'?{digitalTabletop:true}:{}),timeoutMs:5000},signal);check(viewport,correlationId);
      const actual=viewport['viewport'] as {x:number;y:number;scale:number}|null;
      if(viewport['sceneReady']!==true||viewport['incomplete']!==false||!actual||Math.abs(actual.x-stored.viewport.x)>0.5||Math.abs(actual.y-stored.viewport.y)>0.5||Math.abs(actual.scale-stored.viewport.scale)>0.000001)throw new ForestBattlemapError('FOREST_VIEWPORT_NOT_READY');
      const after=await transport.inspectScene(state.sceneId);await this.current(identity,signal);
      if(after.revision!==receipt.revision||after.preparationId!==pkg.id||after.active)throw new ForestBattlemapError('FOREST_SCENE_CHANGED');
      return {status:'display-ready',worldId:identity.worldId,sceneId:state.sceneId,clientId:stored.target.clientId,userId:stored.target.userId,profile:stored.profile,viewport:stored.viewport,displayEvidence:viewport['display'],scalingIntegration:stored.profile==='tv'?'digital-tabletops':'gm-preview',physicalAcceptance:false,providerRequests:0};
    }
    if(operation!=='battlemap-apply'||origin!=='browser'||typeof input['approvalId']!=='string')throw new ForestBattlemapError('FOREST_BROWSER_APPLY_REQUIRED');
    const fresh=await this.display(identity,stored.profile,signal);
    if(fresh.target.clientId!==stored.target.clientId||fresh.target.userId!==stored.target.userId||fresh.display.cssWidth!==stored.display.cssWidth||fresh.display.cssHeight!==stored.display.cssHeight)throw new ForestBattlemapError('FOREST_DISPLAY_CHANGED_REPREPARE_REQUIRED');
    const result=await composer.compose({worldId:identity.worldId,isGm:true},pkg,input['approvalId']);
    await this.current(identity,signal);
    return {status:'created',result,profile:stored.profile,viewport:stored.viewport,physicalAcceptance:false,providerRequests:0,nextAction:stored.profile==='tv'?'Use Display reviewed forest scene to view this exact fixture on the consented fullscreen TV and apply Digital Tabletop calibration. Then measure a grid square with a ruler.':'View the named inactive fixture using Foundry Scenes, then display the reviewed GM preview.'};
  }
}
