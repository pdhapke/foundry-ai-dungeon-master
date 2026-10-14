import {open,call} from './phase4-live-client.mjs';
const c=await open();try {const r=await call(c,'foundry_issue_bridge_enrollment',{lane:'player',userId:'edtBL96Yu3058QAT',ttlMs:600000});console.log(JSON.stringify({clientId:r.clientId,userId:r.userId,lane:r.lane,expiresAt:r.expiresAt,consent:r.client?.consentGranted,delivery:r.client?.delivery}));}finally{await c.close();}
