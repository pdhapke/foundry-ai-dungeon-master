import type { DatabaseSync } from 'node:sqlite';
import type { CampaignStorage } from '../context/campaign-storage.js';
import { hashText, stableJson } from '../context/hash.js';
import type { PreparationRecordStore, PreparationCandidate } from './records.js';
import { PreparationRequestError, preparationErrorCode, type PreparationEffects } from './outcome.js';

export interface PublicationReviewer { worldId: string; userId: string; clientId: string; isGm: boolean }
interface Review {
  schemaVersion: 1; reviewer: PublicationReviewer; candidate: PreparationCandidate;
  companions: Record<string, string | null>; digest: string;
  removedRecordIds?: string[];
  status: 'pending' | 'dispatching' | 'completed' | 'rejected' | 'stale' | 'uncertain';
  receipt?: unknown;
}
/** Private exact-content review. Only the authenticated browser entry may record a decision. */
export class PreparationPublicationReviews {
  constructor(private readonly db: DatabaseSync, private readonly authorize: (caller: PublicationReviewer) => void) {
    db.exec('CREATE TABLE IF NOT EXISTS preparation_publication_reviews (scope TEXT NOT NULL, candidate TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,candidate))');
  }
  private scope(caller: PublicationReviewer) {
    this.authorize(caller);
    if (!caller.isGm || ![caller.worldId, caller.userId, caller.clientId].every(v => /^[A-Za-z0-9_-]{1,128}$/.test(v))) throw Error('Publication review unavailable');
    return JSON.stringify([caller.worldId, caller.userId, caller.clientId]);
  }
  private load(caller: PublicationReviewer, candidateId: string): Review | null {
    const row = this.db.prepare('SELECT body FROM preparation_publication_reviews WHERE scope=? AND candidate=?').get(this.scope(caller), candidateId) as {body: string} | undefined;
    return row ? JSON.parse(row.body) as Review : null;
  }
  private companions(storage: CampaignStorage, worldId: string) {
    return Object.fromEntries(['overview.md', 'index.md'].map(path => {
      try { return [path, storage.read(worldId, path)?.revision ?? null]; }
      catch (e) { if (e instanceof Error && e.message === 'Campaign path does not exist.') return [path, null]; throw e; }
    }));
  }
  private save(caller: PublicationReviewer, review: Review, before: string) {
    const result = this.db.prepare('UPDATE preparation_publication_reviews SET body=? WHERE scope=? AND candidate=? AND body=?').run(JSON.stringify(review), this.scope(caller), review.candidate.candidateId, before);
    if (result.changes !== 1) throw Error('Concurrent publication decision');
  }
  stage(caller: PublicationReviewer, candidateId: string, records: PreparationRecordStore, storage: CampaignStorage, offset=0) {
    if(!Number.isInteger(offset)||offset<0||offset>256)throw Error('Review page bound');
    const previous = this.load(caller, candidateId);
    // A scoped terminal receipt describes historical completion, not current active
    // content. Pending decisions still perform all candidate/companion/CAS checks.
    if(previous?.status==='completed'||previous?.status==='rejected')return this.summary(previous,offset);
    const candidate = records.candidate(caller.worldId, candidateId), companions = this.companions(storage, caller.worldId);
    const active=records.active(caller.worldId);
    const removedRecordIds=(active?.candidate.records??[]).filter(record=>!candidate.records.some(r=>r.id===record.id)).map(r=>r.id);
    const digest = hashText(stableJson({ candidate, companions, removedRecordIds }));
    if (previous) {
      if (previous.digest !== digest) throw Error('Publication review changed');
      return this.summary(previous,offset);
    }
    const review: Review = { schemaVersion: 1, reviewer: caller, candidate, companions, digest, status: 'pending',removedRecordIds };
    this.db.prepare('INSERT OR IGNORE INTO preparation_publication_reviews(scope,candidate,body) VALUES(?,?,?)').run(this.scope(caller), candidateId, JSON.stringify(review));
    const saved = this.load(caller, candidateId)!;
    if (saved.digest !== digest) throw Error('Concurrent publication review');
    return this.summary(saved,offset);
  }
  private summary(review: Review, offset=0) {
    return { candidateId: review.candidate.candidateId, reviewDigest: review.digest, status: review.status,
      recordCount:review.candidate.records.length,continuation:offset+20<review.candidate.records.length?offset+20:null,
      records: review.candidate.records.slice(offset,offset+20).map(r => ({id:r.id,title:r.title,status:r.status,visibility:r.visibility,epistemic:r.epistemic})),
      unresolved: review.candidate.records.flatMap(r => r.unknowns.concat(r.contradictions)).slice(0,8),
      removedFromActiveCount:review.removedRecordIds?.length??0,removedFromActive:(review.removedRecordIds??[]).slice(0,20),
      publicationEffect: ['private overview.md', 'private index.md', 'matching active version; originals preserved'],
      ...(['completed','rejected'].includes(review.status)?{completionEvidence:'historical',activeVersionVerified:false}:{}),
      receipt: review.receipt ?? null };
  }
  read(caller: PublicationReviewer, candidateId: string, recordId: string, section=0,offset=0) {
    const review = this.load(caller, candidateId);
    const record = review?.candidate.records.find(r=>r.id === recordId);
    if (!review || !record) throw Error('Publication review unavailable');
    if(!Number.isInteger(section)||section<0||section>=record.sections.length||!Number.isInteger(offset)||offset<0||offset>record.sections[section]!.text.length)throw Error('Review section bound');
    const current=record.sections[section]!;
    if(offset>0&&/[\uDC00-\uDFFF]/.test(current.text[offset]??''))throw Error('Invalid Unicode review offset');
    let end=Math.min(current.text.length,offset+3500);if(/[\uD800-\uDBFF]/.test(current.text[end-1]??''))end--;
    const text=current.text.slice(offset,end);
    const next=offset+text.length<current.text.length?{section,offset:offset+text.length}:section+1<record.sections.length?{section:section+1,offset:0}:null;
    return {reviewDigest:review.digest,record:{id:record.id,title:record.title,kind:record.kind,status:record.status,epistemic:record.epistemic,visibility:record.visibility,revision:record.revision,
      sources:record.sources[section]?[record.sources[section]]:record.sources.slice(0,4),
      sourceCount:record.sources.length,unknowns:record.unknowns.slice(0,4),contradictions:record.contradictions.slice(0,4),sectionCount:record.sections.length,
      section:{heading:current.heading,text,offset}},continuation:next,reviewOnly:true,narrationAllowed:false};
  }
  confirm(caller:PublicationReviewer,candidateId:string,newCandidateId:string,digest:string,origin:'browser'|'dm',records:PreparationRecordStore,storage:CampaignStorage) {
    this.scope(caller);
    if(origin!=='browser')throw Error('Explicit authenticated GM browser confirmation required');
    const review=this.load(caller,candidateId);
    if(!review||review.digest!==digest||review.status!=='pending')throw Error('Exact pending review required');
    const current=records.candidate(caller.worldId,candidateId);
    if(stableJson(current)!==stableJson(review.candidate)||stableJson(this.companions(storage,caller.worldId))!==stableJson(review.companions))throw Error('Review changed before confirmation');
    // Preserve epistemic qualifiers: confirmation accepts the record, never converts a rumor/proposal to fact.
    const candidate={...current,candidateId:newCandidateId,records:current.records.map(record=>({...record,status:'confirmed' as const}))};
    try { records.stage(candidate); }
    catch(error) { throw new PreparationRequestError('operation','unknown',preparationErrorCode(error),error); }
    try { return this.stage(caller,newCandidateId,records,storage); }
    catch(error) { throw new PreparationRequestError('operation','committed',preparationErrorCode(error),error); }
  }
  decide(caller: PublicationReviewer, candidateId: string, digest: string, decision: 'approve'|'reject', origin: 'browser'|'dm', records: PreparationRecordStore, storage: CampaignStorage) {
    // Independent processes serialize the synchronous review+commit. A crash rolls
    // back this claim; CampaignStorage's separate durable receipt recovers the file commit.
    this.db.exec('BEGIN IMMEDIATE');
    const state:{effects:PreparationEffects}={effects:'none'};
    try {
      const result = this.decideLocked(caller,candidateId,digest,decision,origin,records,storage,value=>{state.effects=value;});
      this.db.exec('COMMIT'); return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { if(state.effects!=='committed')state.effects='unknown'; }
      throw new PreparationRequestError('operation',state.effects,preparationErrorCode(e),e);
    }
  }
  private decideLocked(caller: PublicationReviewer, candidateId: string, digest: string, decision: 'approve'|'reject', origin: 'browser'|'dm', records: PreparationRecordStore, storage: CampaignStorage, outcome:(effects:PreparationEffects)=>void) {
    this.scope(caller);
    if (origin !== 'browser') throw Error('Explicit authenticated GM browser decision required');
    const review = this.load(caller, candidateId);
    if (!review || review.digest !== digest) throw Error('Exact publication review required');
    if (review.status === 'completed' || review.status === 'rejected') return this.summary(review);
    if (review.status === 'stale') throw Error('Publication review is stale');
    const before = JSON.stringify(review);
    if (decision === 'reject') { review.status='rejected'; this.save(caller,review,before); return this.summary(review); }
    const current = records.candidate(caller.worldId,candidateId);
    if (stableJson(current)!==stableJson(review.candidate)) throw Error('Candidate changed after review');
    // Resume after an interrupted commit through the underlying durable publication receipt.
    if (!records.publicationReceipt(caller.worldId,candidateId) && stableJson(this.companions(storage,caller.worldId)) !== stableJson(review.companions)) throw Error('Canonical companions changed after review');
    review.status='dispatching'; this.save(caller,review,before);
    const claimed = JSON.stringify(review);
    try { review.receipt=records.publish(caller.worldId,candidateId); outcome('committed'); review.status='completed'; }
    catch(e) {
      try { outcome(records.publicationReceipt(caller.worldId,candidateId)?'committed':'none'); }
      catch { outcome('unknown'); }
      review.status='uncertain'; this.save(caller,review,claimed); throw e;
    }
    this.save(caller,review,claimed);
    return this.summary(review);
  }
  assertApproved(caller: PublicationReviewer, candidateId: string) {
    const review = this.load(caller,candidateId);
    if (!review || review.status !== 'dispatching') throw Error('Explicit publication review approval required');
  }
}
