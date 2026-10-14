import { latencyEvent } from '../latency-trace.js';

export type PreparationEffects = 'none' | 'committed' | 'unknown';
export type PreparationPhase = 'gateway-initial-authorization' | 'service-initial-authorization' | 'publication-pre-dispatch-authorization' | 'operation' | 'service-final-authorization' | 'gateway-final-authorization';
const stringCodes = new Set(['TIMEOUT','NOT_CONNECTED','PERMISSION_DENIED','INVALID_PAYLOAD','UNSUPPORTED','CAPABILITY_UNAVAILABLE','CANCELLED','MCP_REQUEST_TIMEOUT','MCP_CONNECTION_ERROR','MCP_INVALID_PARAMS','MCP_INTERNAL_ERROR','UNAVAILABLE']);
const forestCodes = new Set(['FOREST_TEST_GM_REQUIRED','FOREST_CLIENT_CONTRACT_MISMATCH','FOREST_BROWSER_BUDGET_BINDING_REQUIRED','FOREST_APPROVED_BUDGET_NOT_CONFIGURED','FOREST_WORLD_CHANGED','FOREST_CAPABILITY_SCHEMA_UNAVAILABLE','FOREST_RESPONSE_INVALID','FOREST_PUBLIC_ROOT_REDIRECT','FOREST_MAP_ROOT_REDIRECT','FOREST_APPROVED_IMPORT_REQUIRED','FOREST_APPROVED_SOURCE_NOT_STAGED','FOREST_ASSET_RECEIPT_MISMATCH','FOREST_ASSET_REDIRECT','FOREST_ASSET_CHANGED','FOREST_PACKAGE_INVALID','FOREST_PACKAGE_UNAVAILABLE','FOREST_EXACT_TV_REQUIRED','FOREST_EXACT_GM_REQUIRED','FOREST_TV_ROLE_MISMATCH','FOREST_GM_ROLE_MISMATCH','FOREST_FRESH_DISPLAY_REQUIRED','FOREST_APPROVAL_SCOPE_CHANGED','FOREST_INPUT_INVALID','FOREST_BROWSER_IMPORT_REQUIRED','FOREST_EXPLICIT_PROFILE_REQUIRED','FOREST_PACKAGE_CONFLICT','FOREST_EXACT_BROWSER_REVIEW_REQUIRED','FOREST_BROWSER_APPLY_REQUIRED','FOREST_DISPLAY_CHANGED_REPREPARE_REQUIRED','FOREST_BROWSER_DISPLAY_REQUIRED','FOREST_CREATED_SCENE_REQUIRED','FOREST_SCENE_CHANGED','FOREST_VIEW_NAMED_SCENE_FIRST','FOREST_PRELOAD_NOT_READY','FOREST_VIEWPORT_NOT_READY']);
/** Never log private error prose, arbitrary codes, arguments or credentials. */
export function preparationErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNAVAILABLE';
  const value=error as {code?:unknown;name?:unknown;reasonCode?:unknown};
  if(typeof value.reasonCode==='string'&&stringCodes.has(value.reasonCode))return value.reasonCode;
  if(typeof value.code==='string'&&stringCodes.has(value.code))return value.code;
  if(typeof value.code==='string'&&forestCodes.has(value.code))return value.code;
  if(value.code===-32001)return 'MCP_REQUEST_TIMEOUT';
  if(value.code===-32000)return 'MCP_CONNECTION_ERROR';
  if(value.code===-32602)return 'MCP_INVALID_PARAMS';
  if(value.code===-32603)return 'MCP_INTERNAL_ERROR';
  if(value.name==='TimeoutError')return 'TIMEOUT';
  if(value.name==='AbortError')return 'CANCELLED';
  if(value.name==='ZodError')return 'INVALID_PAYLOAD';
  return 'UNAVAILABLE';
}
export function preparationPhaseEvent(phase: PreparationPhase, outcome:'returned'|'error', error?:unknown):void {
  latencyEvent(`preparation:${phase}:${outcome==='error'?preparationErrorCode(error).toLowerCase():'complete'}`,undefined,outcome);
}

// Internal compatibility uses only exact static messages; public replies and traces
// never include error prose, even for these known validation failures.
const safeMessages=new Set(['Source revision conflict','Editable record revision conflict','Preparation revision conflict','Companion revision conflict','Interview source revision conflict','Interview source identity conflict','Native preparation job changed','Explicit authenticated GM browser confirmation required','Explicit authenticated GM browser decision required','Explicit authenticated GM browser asset approval required','Exact authenticated GM browser review required','Explicit authenticated GM browser apply request required']);
function safeCompatibilityMessage(cause:unknown):string { return cause instanceof Error&&safeMessages.has(cause.message)?cause.message:'Preparation outcome requires an authorized status check.'; }

export class PreparationRequestError extends Error {
  constructor(readonly phase:PreparationPhase,readonly effects:PreparationEffects,readonly reasonCode:string, cause?:unknown) {
    super(safeCompatibilityMessage(cause));
    this.name='PreparationRequestError';
  }
}
// Trusted in-process marker, not a JSON field that imported source/sidecar data can forge.
const effectsByResult=new WeakMap<object,PreparationEffects>();
export function markPreparationResult<T extends object>(result:T,effects:PreparationEffects):T { effectsByResult.set(result,effects);return result; }
export function preparationResultEffects(result:unknown):PreparationEffects { return result&&typeof result==='object'?effectsByResult.get(result)??'none':'none'; }

/** No candidate IDs, receipt details, record counts, source text or arbitrary error messages. */
export function preparationFailureResponse(error:PreparationRequestError) {
  const revalidation=error.phase.endsWith('-authorization');
  const outcome=error.effects==='committed'?(revalidation?'committed-revalidation-required':'committed-status-required'):error.effects==='unknown'?'outcome-unknown':revalidation?'authorization-required':'not-committed';
  return {status:revalidation?403:409,body:{
    state:outcome,code:revalidation?'PREPARATION_REVALIDATION_REQUIRED':'PREPARATION_OPERATION_FAILED',
    ...(forestCodes.has(error.reasonCode)?{reasonCode:error.reasonCode}:{}),
    outcome,success:false,currentAuthorizationVerified:false,
    error:error.effects==='committed'?'A preparation outcome is durably recorded. Reconnect and check authorized status before retrying changes.':error.effects==='unknown'?'Preparation completion could not be verified. Reconnect and check authorized status before retrying changes.':'Preparation did not establish a committed outcome. Reconnect or correct the request before retrying.',
  }};
}
