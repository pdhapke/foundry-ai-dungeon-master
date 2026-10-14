import {open,call} from './phase4-live-client.mjs';
import {writeFileSync} from 'node:fs';
const c=await open();try {
 const sceneId='Nbj38PEdvw1zX1J9',tokenId='5afpFlCHHnclifNw',effectiveUserId='edtBL96Yu3058QAT',clientId='80f7f865-6ebf-4a83-ad44-33ab0c0747f2';
 const scene=await call(c,'foundry_get_scene',{id:sceneId}),token=scene.tokens.find(t=>(t._id??t.id)===tokenId);
 if(!token||token.elevation!==0)throw Error('Proposed point elevation requires review');
 const observation=await call(c,'foundry_get_token_visibility',{sceneId,tokenId,effectiveUserId,clientId,queryPoints:[{id:'terrain-calibration',x:525,y:325,elevation:0}]});
 const report={capturedAt:new Date().toISOString(),scope:'Native model-free query of proposed local public description point; no description approved or published by this preflight.',observation,inferenceRequests:0,mutations:0};
 writeFileSync('docs/prompt4-terrain-point-preflight.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({status:observation.status,readiness:observation.observation?.readiness,issues:observation.issues,queryPoints:observation.queryPoints}));
}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=1;}finally{await c.close();}
