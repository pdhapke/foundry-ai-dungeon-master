import assert from 'node:assert/strict';
import test from 'node:test';
import {PreparationRequestError,preparationErrorCode,preparationFailureResponse,markPreparationResult,preparationResultEffects} from './outcome.js';

test('postcommit authorization failure is qualified and contains no private error data',()=>{
 const privateError=Object.assign(Error('SECRET receipt world candidate bearer token'),{code:'SECRET'});
 const failure=preparationFailureResponse(new PreparationRequestError('service-final-authorization','committed',preparationErrorCode(privateError),privateError));
 assert.equal(failure.status,403);
 assert.equal(failure.body.outcome,'committed-revalidation-required');
 assert.equal(failure.body.success,false);
 assert.equal(failure.body.currentAuthorizationVerified,false);
 assert.doesNotMatch(JSON.stringify(failure),/SECRET|bearer|candidate|world|receipt/);
});
test('precommit, uncertain and committed operation failures remain distinct',()=>{
 assert.equal(preparationFailureResponse(new PreparationRequestError('operation','none','INVALID_PAYLOAD')).body.outcome,'not-committed');
 assert.equal(preparationFailureResponse(new PreparationRequestError('operation','unknown','UNAVAILABLE')).body.outcome,'outcome-unknown');
 assert.equal(preparationFailureResponse(new PreparationRequestError('operation','committed','UNAVAILABLE')).body.outcome,'committed-status-required');
 assert.equal(preparationFailureResponse(new PreparationRequestError('service-initial-authorization','none','PERMISSION_DENIED')).body.outcome,'authorization-required');
});
test('untrusted JSON cannot claim committed effects',()=>{
 const forged={effects:'committed',success:true};
 assert.equal(preparationResultEffects(forged),'none');
 const trusted=markPreparationResult({result:1},'committed');
 assert.equal(preparationResultEffects(trusted),'committed');
 assert.equal(preparationResultEffects(JSON.parse(JSON.stringify(trusted))),'none');
});
test('telemetry codes use a closed projection and retain typed error codes',()=>{
 assert.equal(preparationErrorCode({code:-32001}),'MCP_REQUEST_TIMEOUT');
 assert.equal(preparationErrorCode({code:'private secret'}),'UNAVAILABLE');
 assert.equal(preparationErrorCode(new PreparationRequestError('operation','none','INVALID_PAYLOAD')),'INVALID_PAYLOAD');
 assert.equal(preparationErrorCode(new PreparationRequestError('operation','none','secret')),'UNAVAILABLE');
});
