import { stableJson } from '../context/hash.js';
import { validateRecords, type PreparationCandidate, type PreparationRecordStore, type CampaignRecord } from './records.js';
import { resolveSelectedSourceReferences } from './source-drafts.js';
/** Mechanical composition: preserve active records and replace only explicit source IDs.
 * No facts, aliases, relationships or contradiction resolutions are inferred. */
export function composePreparationCandidates(store:PreparationRecordStore,worldId:string,candidateId:string,packetIds:string[],overviewPacketId?:string):PreparationCandidate {
  if(!packetIds.length||packetIds.length>16||new Set(packetIds).size!==packetIds.length)throw Error('Explicit bounded candidate selections required');
  const packets=packetIds.map(id=>store.candidate(worldId,id));
  const active=store.active(worldId);
  const records=new Map<string,CampaignRecord>((active?.candidate.records??[]).filter(r=>r.kind!=='overview'&&r.kind!=='index').map(r=>[r.id,r]));
  const selected=new Map<string,CampaignRecord>();
  for(const packet of packets)for(const record of packet.records) {
    if(record.kind==='overview'||record.kind==='index')continue;
    const previous=selected.get(record.id);
    if(previous&&stableJson(previous)!==stableJson(record))throw Error('Conflicting selected record revisions');
    selected.set(record.id,record);
  }
  for(const [id,record]of selected)records.set(id,record);
  const overviewPacket=packets.find(p=>p.candidateId===(overviewPacketId??packetIds[0]));
  const overview=overviewPacket?.records.find(r=>r.kind==='overview');
  if(!overview)throw Error('Explicit overview candidate unavailable');
  const details=[...records.values()].sort((a,b)=>a.id.localeCompare(b.id));
  const refs=[...new Map(details.flatMap(r=>r.sources).map(s=>[`${s.uri}:${s.startLine}:${s.endLine}`,s])).values()];
  const counts=Object.fromEntries([...new Set(details.map(r=>r.kind))].sort().map(kind=>[kind,details.filter(r=>r.kind===kind).length]));
  const index:CampaignRecord={...overview,id:'prepared-index',kind:'index',title:'Prepared campaign retrieval directory',status:'draft',epistemic:'proposed',generated:false,sources:refs.slice(0,64),relationships:[],
    sections:[{heading:'Bounded record directory',text:`This private candidate contains ${details.length} source records. Kinds: ${Object.entries(counts).map(([kind,count])=>`${kind}: ${count}`).join(', ')}. Detailed records remain on demand through exact ID/name lookup and campaign search. This directory does not establish narrative consistency, player knowledge or live readiness.`}],
    unknowns:['Source records preserve original claims, including uncertainties and private mysteries. Human review must resolve consequential contradictions and disclosure.'],contradictions:[]};
  const all=validateRecords(worldId,resolveSelectedSourceReferences([{...overview,status:'draft'},index,...details]));
  const manifest:Record<string,string>={};
  for(const record of all)for(const source of record.sources) {
    if(manifest[source.uri]&&manifest[source.uri]!==source.hash)throw Error('Conflicting source versions');manifest[source.uri]=source.hash;
  }
  // Companion CAS hashes must also be retained across incremental publication.
  for(const path of ['overview.md','index.md']) {
    const uri=`campaign://${worldId}/${path}`;
    const hash=packets.map(p=>p.manifest[uri]).find(Boolean)??active?.candidate.manifest[uri];
    if(hash)manifest[uri]=hash;
  }
  return {schemaVersion:1,worldId,candidateId,baseRevision:active?.revision??null,records:all,manifest};
}
