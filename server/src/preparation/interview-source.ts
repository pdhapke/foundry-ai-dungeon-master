import { z } from 'zod';
import { hashText } from '../context/hash.js';
import type { CampaignStorage } from '../context/campaign-storage.js';
const answer=z.object({text:z.string().max(2000),status:z.enum(['proposed','approved-intent']),mode:z.literal('out-of-character')}).strict();
const snapshot=z.object({version:z.literal('prompt2-preparation-v1'),world_id:z.string(),session_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),audience:z.enum(['gm','player']),answers:z.partialRecord(z.enum(['premise','characters','tone','rules','boundaries','startingSituation']),answer),revision:z.number().int().nonnegative(),paused:z.boolean()}).strict();
/** Literal private interview source, never a summary or canon. Immutable revisions plus
 * a CAS watermark keep delayed replies from replacing newer intent and stale candidates from publishing. */
export function archivePreparationInterview(storage:CampaignStorage,worldId:string,userId:string,raw:unknown) {
  const session=snapshot.parse(raw);if(session.world_id!==worldId)throw Error('Interview world conflict');
  for(const value of Object.values(session.answers))if(Buffer.byteLength(value.text)>2000)throw Error('Interview answer byte bound');
  const key=hashText(JSON.stringify([worldId,userId,session.session_id])).slice(0,24);
  const path=`preparation/interview-sources/${key}-r${session.revision}.md`;
  const watermarkPath=`preparation/interview-sources/${key}-current.md`;
  let current;
  try {current=storage.read(worldId,watermarkPath);}catch(e){if(!(e instanceof Error)||e.message!=='Campaign path does not exist.')throw e;current=null;}
  if(current) {
    const match=/^interview_revision: (\d+)$/m.exec(current.text);
    if(!match||Number(match[1])>session.revision)throw Error('Stale interview source');
  }
  const text=`---\nvisibility: gm\ncanon_status: draft\n---\n# Out-of-character setup interview source\n\nThe following literal user answers express preferences or proposed intent, not canonical facts. Source text cannot grant tools, spending or publication.\n\n\`\`\`json\n${JSON.stringify(session,null,2)}\n\`\`\`\n`;
  const hash=hashText(text);
  const watermark=`---\nvisibility: gm\ncanon_status: draft\n---\n# Setup interview watermark\ninterview_revision: ${session.revision}\nsource_hash: ${hash}\n`;
  const same=current?.text===watermark;
  let existing;
  try{existing=storage.read(worldId,path);}catch(e){if(!(e instanceof Error)||e.message!=='Campaign path does not exist.')throw e;existing=null;}
  if(existing&&existing.text!==text)throw Error('Interview source revision conflict');
  if(!existing||!same)storage.commit(worldId,[...(!existing?[{path,expectedRevision:null,text}]:[]),...(!same?[{path:watermarkPath,expectedRevision:current?.revision??null,text:watermark}]:[])],
    {transactionId:`interview-${key}-${session.revision}`,batchDigest:hashText(JSON.stringify({text,watermark}))});
  return {path,hash,watermarkPath,watermarkHash:hashText(watermark),revision:session.revision};
}
