import { retryDelaySeconds } from '../retry/backoff.js';
import { sha256TextHex } from '../security/internalAuth.js';
import { normalizeUiJob, sameScope, TERMINAL_UI_ITEMS, uiError, validateCompilation, validatePublication, validWake, wakeFor } from './contracts.js';
import { uiRepository } from './repository.js';
import { uiGatewayCall } from './gatewayClient.js';

export async function dispatchUiWork(env,repo,{jobId=null,limit=50}={}) {
  const due=await repo.due({jobId,limit}); let queued=0,deferred=0;
  for(const item of due){
    try {
      if(!env?.TEST_DESIGN_GENERATION_QUEUE?.send) throw uiError('UI_JOB_QUEUE_NOT_CONFIGURED',503,true);
      await env.TEST_DESIGN_GENERATION_QUEUE.send(wakeFor(item));
      await repo.dispatched(item); queued++;
    } catch { deferred++; }
  }
  return {queued,deferred};
}
export async function createUiJob(env,scope,input,{repo=uiRepository(env)}={}) {
  if(!env?.TEST_DESIGN_GENERATION_QUEUE?.send) throw uiError('UI_JOB_QUEUE_NOT_CONFIGURED',503,true);
  const definition=await normalizeUiJob(input,scope);
  const admitted=await repo.create(definition);
  const dispatch=await dispatchUiWork(env,repo,{jobId:admitted.job.jobId});
  return { ...await repo.publicJob(scope,admitted.job.jobId),reused:admitted.reused,dispatch };
}
export async function recoverUiJobs(env,{repo=null}={}) {
  const repository=repo||uiRepository(env);
  if(!await repository.ready()) return {ready:false,code:'UI_JOB_SCHEMA_NOT_READY',queued:0,deferred:0};
  await repository.refreshActive();
  return {ready:true,...await dispatchUiWork(env,repository)};
}
function retryClassification(error) {
  const code=/^[A-Z][A-Z0-9_]{0,127}$/.test(error?.code||'')?error.code:'UI_JOB_TEMPORARY_FAILURE';
  // Unlike the legacy AI retry classifier, explicit permanent contract/source
  // failures remain permanent even when the callback uses HTTP 502.
  return {code,retryable:typeof error?.retryable==='boolean'?error.retryable:!error?.status||error.status===429||error.status>=500};
}
export async function processUiMessage(message,env,{repo=uiRepository(env),call=uiGatewayCall}={}) {
  const body=message?.body;
  if(!validWake(body)){message?.ack?.();return {ignored:true,reason:'UI_WAKE_INVALID'};}
  const original=await repo.getItem(body.jobItemId);
  if(!original||original.jobId!==body.jobId||!sameScope(original,body)){message?.ack?.();return {ignored:true,reason:'UI_WAKE_SCOPE_MISMATCH'};}
  if(TERMINAL_UI_ITEMS.has(original.status)){await repo.refresh(original.jobId);message?.ack?.();return {ignored:true,reason:'UI_ITEM_TERMINAL'};}
  const claim=await repo.claim(original.jobItemId);
  if(!claim){
    const current=await repo.getItem(original.jobItemId);
    if(current&&!TERMINAL_UI_ITEMS.has(current.status)) message?.retry?.({delaySeconds:15});
    else message?.ack?.();
    return {ignored:true,reason:'UI_ITEM_NOT_CLAIMABLE'};
  }
  const {job,item}=claim;
  const common={organizationId:job.organizationId,projectId:job.projectId,environmentId:job.environmentId,jobId:job.jobId,jobItemId:item.jobItemId,generationRequestId:item.generationRequestId};
  try {
    let saved;
    if(item.stage==='COMPILE'){
      const compilation=await call(env,'compile',{...common,bundleVersionId:item.bundleVersionId,compilerVersion:job.compilerVersion,profile:job.profile});
      const candidate=await validateCompilation(compilation,job,item);
      saved=await repo.saveCandidate(item,candidate);
    } else {
      if(!item.candidateJson||await sha256TextHex(item.candidateJson)!==item.candidateHash) throw uiError('UI_CANDIDATE_HASH_MISMATCH',409,false);
      let compilation; try{compilation=JSON.parse(item.candidateJson);}catch{throw uiError('UI_CANDIDATE_INVALID',409,false);}
      const candidate=await validateCompilation(compilation,job,item);
      if(compilation.outcome!=='COMPILED'||candidate.specificationHash!==item.specificationHash) throw uiError('UI_CANDIDATE_INVALID',409,false);
      if(!await repo.markPublicationStarted(item)) {message?.ack?.();return {ignored:true,reason:'UI_ITEM_LEASE_LOST'};}
      const result=validatePublication(await call(env,'publish',{...common,compilation}),candidate);
      saved=await repo.completePublication(item,result);
    }
    await repo.refresh(job.jobId);
    if(saved?.status==='COMPILED') await dispatchUiWork(env,repo,{jobId:job.jobId});
    message?.ack?.();
    return {processed:Boolean(saved),status:saved?.status||'FENCED'};
  } catch(error) {
    const failure=retryClassification(error);
    const delaySeconds=retryDelaySeconds(item.stage==='COMPILE'?item.compileAttempts:item.publishAttempts);
    const saved=await repo.fail(item,job,{...failure,delaySeconds});
    await repo.refresh(job.jobId);
    if(saved?.status==='RETRY_WAIT') message?.retry?.({delaySeconds}); else message?.ack?.();
    // No source bodies, private values, arbitrary upstream messages or credentials.
    console.info(JSON.stringify({t:'qagent_ui_test_design_job',event:'item.stage_failed',jobId:job.jobId,jobItemId:item.jobItemId,stage:item.stage,code:failure.code,status:saved?.status||'FENCED'}));
    return {processed:Boolean(saved),status:saved?.status||'FENCED',code:failure.code};
  }
}
