import { existsSync, lstatSync, realpathSync, opendirSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
export type PrivacyBlocker = 'public-campaign-copies' | 'public-operational-store' | 'protected-storage-unavailable';
export class PreparationPrivacyError extends Error {
 constructor(readonly blockers: readonly PrivacyBlocker[]) { super('Privacy action required'); }
}
export interface LegacyCampaignInspection {
 ready: boolean; sourceCopies: number; publicAssets: number; unsafeArtifacts: number;
 inspection: 'absent' | 'bounded';
}
function recognizedMedia(path: string, size: number): boolean {
 if (size < 4 || size > 536870912) return false;
 const header=Buffer.alloc(64); const fd=openSync(path,'r'); let length=0;
 try { length=readSync(fd,header,0,64,0); } finally { closeSync(fd); }
 const h=header.subarray(0,length), ext=extname(path).toLowerCase();
 const text=(a:number,b:number)=>h.subarray(a,b).toString('ascii');
 switch(ext){
 case '.png': return h.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 case '.jpg': case '.jpeg': return h[0]===255 && h[1]===216 && h[2]===255;
 case '.gif': return ['GIF87a','GIF89a'].includes(text(0,6));
 case '.webp': return text(0,4)==='RIFF' && text(8,12)==='WEBP';
 case '.wav': return text(0,4)==='RIFF' && text(8,12)==='WAVE';
 case '.ogg': return text(0,4)==='OggS';
 case '.mp3': return text(0,3)==='ID3' || (h[0]===255 && ((h[1]??0)&224)===224);
 case '.mp4': return text(4,8)==='ftyp';
 case '.webm': return h.subarray(0,4).equals(Buffer.from([26,69,223,163]));
 default: return false;
 }
}
/** Source-copy gate only. Public images/media still require a separate disclosure audit. No file paths leave this result. */
export function inspectLegacyCampaign(worldsRoot: string, worldId: string): LegacyCampaignInspection {
 const result: LegacyCampaignInspection={ready:false,sourceCopies:0,publicAssets:0,unsafeArtifacts:0,inspection:'bounded'};
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(worldId)) {result.unsafeArtifacts++;return result;}
 const root=resolve(worldsRoot), world=join(root,worldId), data=join(world,'data'), campaign=join(data,'campaign');
 try {
  for(const path of [root,world,data,campaign]) {
   if(!existsSync(path)){result.inspection='absent';result.ready=true;return result;}
   const stat=lstatSync(path);if(stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path)!==path)throw Error('Redirect');
  }
  let entries=0,bytes=0;
  const walk=(directory:string,prefix:string,depth:number):void=>{
   if(depth>12)throw Error('Depth budget');
   const handle=opendirSync(directory);
   try { let next;
   while((next=handle.readSync())!==null){
    const entry=next.name;
    if(++entries>4096)throw Error('Entry budget');
    const path=join(directory,entry), relative=prefix+entry,stat=lstatSync(path);
    if(stat.isSymbolicLink() || realpathSync(path)!==path)throw Error('Redirect');
    const inAssets=relative==='assets' || relative.startsWith('assets/');
    if(stat.isDirectory()) { if(!inAssets)result.unsafeArtifacts++;walk(path,relative+'/',depth+1);continue; }
    if(!stat.isFile()) {result.unsafeArtifacts++;continue;}
    bytes+=stat.size;if(bytes>2147483648)throw Error('Byte budget');
    if(inAssets && recognizedMedia(path,stat.size))result.publicAssets++;
    else result.sourceCopies++;
   }
   } finally { handle.closeSync(); }
  };
  walk(campaign,'',0);
  result.ready=result.sourceCopies===0 && result.unsafeArtifacts===0;
 } catch {result.unsafeArtifacts++;result.ready=false;}
 return result;
}
