/** Explicit local operator helper. No runtime route, automatic execution or model authority.
 * All cooperative writers must honor CampaignStorage's lock; administrators must not
 * write concurrently. A crash-held lock requires verified stopped-owner recovery.
 */
import {existsSync,lstatSync,realpathSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmdirSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {assertProtectedCampaignRoot} from '../server/dist/context/protected-campaign.js';
const paths=['overview.md','index.md','preparation/active.md'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function context(options){
 const protectedRoot=assertProtectedCampaignRoot(options);
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(options.worldId)||!/^[A-Za-z0-9_-]{1,64}$/.test(options.operationId))throw Error('Invalid operator scope');
 if(typeof options.authorize!=='function')throw Error('Explicit operator authorization required');
 options.authorize(options.worldId,options.operationId);
 const root=resolve(protectedRoot,options.worldId,'data','campaign');
 const rel=relative(protectedRoot,root);if(isAbsolute(rel)||rel.startsWith(`..${sep}`))throw Error('Invalid root');
 for(let current=protectedRoot;current!==root;){const next=rel.split(sep).slice(relative(protectedRoot,current).split(sep).filter(Boolean).length)[0];current=join(current,next);if(lstatSync(current).isSymbolicLink()||realpathSync(current)!==resolve(current))throw Error('Redirected campaign');}
 if(existsSync(join(root,'.transaction.json')))throw Error('Campaign recovery required');
 const target=path=>{let current=root;for(const part of path.split('/')){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('Redirected target');}return current;};
 return {root,target,authorize:()=>options.authorize(options.worldId,options.operationId)};
}
export function captureFirstPublicationBaseline(options){
 const {root,target,authorize}=context(options);if(existsSync(join(root,'.write-lock')))throw Error('Campaign writer active');
 for(const path of paths)if(existsSync(target(path)))throw Error('First-publication baseline must be absent');
 authorize();return {schemaVersion:1,worldId:options.worldId,files:Object.fromEntries(paths.map(path=>[path,null]))};
}
export function rollbackFirstPublication(options,baseline,expected){
 const {root,target,authorize}=context(options);
 if(baseline?.schemaVersion!==1||baseline.worldId!==options.worldId||JSON.stringify(Object.keys(baseline.files).sort())!==JSON.stringify([...paths].sort())||paths.some(path=>baseline.files[path]!==null))throw Error('Exact absent baseline required');
 if(!expected||JSON.stringify(Object.keys(expected).sort())!==JSON.stringify([...paths].sort())||paths.some(path=>!/^[a-f0-9]{64}$/.test(expected[path])))throw Error('Exact publication hashes required');
 const archive=target(`preparation/first-publication-rollbacks/${options.operationId}`),receipt=target(`preparation/first-publication-rollbacks/${options.operationId}/receipt.json`);
 const lock=join(root,'.write-lock');mkdirSync(lock);let release=true;
 const moved=[];
 try {
  if(existsSync(join(root,'.transaction.json')))throw Error('Campaign recovery required');
  if(existsSync(receipt)){
   const prior=JSON.parse(readFileSync(receipt,'utf8'));
   if(prior.worldId!==options.worldId||JSON.stringify(prior.expected)!==JSON.stringify(expected))throw Error('Rollback receipt conflict');
   for(const path of paths)if(existsSync(target(path))||hash(readFileSync(join(archive,path.replaceAll('/','_'))))!==expected[path])throw Error('Rollback replay drift');
   return prior;
  }
  for(const path of paths)if(!existsSync(target(path))||hash(readFileSync(target(path)))!==expected[path])throw Error('Publication revision conflict');
  if(existsSync(archive))throw Error('Interrupted rollback archive requires operator recovery');
  authorize();mkdirSync(archive,{recursive:true});
  writeFileSync(join(archive,'baseline.json'),JSON.stringify(baseline),{flag:'wx'});
  writeFileSync(join(archive,'intent.json'),JSON.stringify({worldId:options.worldId,expected}),{flag:'wx'});
  for(const path of paths){authorize();const from=target(path),to=join(archive,path.replaceAll('/','_'));if(hash(readFileSync(from))!==expected[path])throw Error('Publication revision conflict');renameSync(from,to);moved.push({from,to});options.afterMove?.(path);}
  for(const path of paths)if(existsSync(target(path))||hash(readFileSync(join(archive,path.replaceAll('/','_'))))!==expected[path])throw Error('Rollback readback conflict');
  authorize();const result={schemaVersion:1,worldId:options.worldId,operationId:options.operationId,status:'restored-absence',expected,archive,retainsVersionedRecords:true};
  writeFileSync(receipt,JSON.stringify(result),{flag:'wx'});return result;
 }catch(error){
  try{for(const {from,to} of [...moved].reverse()){if(existsSync(from))throw Error('Compensation target changed');renameSync(to,from);}}catch{release=false;throw Error('Rollback compensation failed; preserve lock and archive for stopped-owner recovery');}
  throw error;
 }finally{if(release)rmdirSync(lock);}
}
