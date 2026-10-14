/** Explicit local operator staging for a reviewed large candidate. No publication path.
 * Keeps the browser/model envelope bounded; final confirmation/publication still use
 * server-issued digests and the authenticated GM browser, never this helper.
 */
import {createHash} from 'node:crypto';
import {CampaignStorage} from '../server/src/context/campaign-storage.ts';
import {CampaignSourceRepository} from '../server/src/context/campaign-source.ts';
import {worldCampaignRoot} from '../server/src/context/world-campaign.ts';
import {PreparationRecordStore,validateRecords} from '../server/src/preparation/records.ts';
export function stageReviewedCandidate(options,text,expectedFileHash){
 if(typeof options.authorize!=='function')throw Error('Explicit operator authorization required');
 options.authorize(options.worldId);
 if(Buffer.byteLength(text)>8_000_000||createHash('sha256').update(text).digest('hex')!==expectedFileHash)throw Error('Exact reviewed candidate digest required');
 const candidate=JSON.parse(text);if(candidate.worldId!==options.worldId||candidate.records.some(r=>r.status!=='draft'))throw Error('Private draft world/status required');
 validateRecords(options.worldId,candidate.records);
 const storage=new CampaignStorage(options.protectedRoot,{authorize:world=>{if(world!==options.worldId)throw Error('World scope');options.authorize(world);},assertPrivateStorage:()=>{}},128000,512000,{protectedRoot:options.protectedRoot,publicDataRoot:options.publicDataRoot});
 const sourceHash=(world,uri)=>{if(world!==options.worldId||!uri.startsWith(`campaign://${world}/`))throw Error('Source world scope');return new CampaignSourceRepository([{rootId:world,path:worldCampaignRoot(options.protectedRoot,world)}]).load(world,uri.slice(`campaign://${world}/`.length)).sourceHash;};
 const records=new PreparationRecordStore(storage,()=>{throw Error('Publication forbidden in staging helper');},sourceHash);
 if(records.activeRevision(options.worldId)!==candidate.baseRevision)throw Error('Active version conflict');
 for(const [uri,expected]of Object.entries(candidate.manifest))if(sourceHash(options.worldId,uri)!==expected)throw Error('Source revision conflict');
 const receipt=records.stage(candidate);
 for(const [uri,expected]of Object.entries(candidate.manifest))if(sourceHash(options.worldId,uri)!==expected)throw Error('Source changed; staged draft cannot publish');
 const readback=records.candidate(options.worldId,candidate.candidateId);
 return{status:'private-draft-staged',candidateId:readback.candidateId,recordCount:readback.records.length,receipt,publicationApproved:false};
}
