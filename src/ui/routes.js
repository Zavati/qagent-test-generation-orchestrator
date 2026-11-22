import { verifyInternalRequest } from '../security/internalAuth.js';
import { scopeOf, uiError, validId } from './contracts.js';
import { uiRepository } from './repository.js';
import { createUiJob, dispatchUiWork } from './service.js';

function pagination(url) {
  const raw=url.searchParams.get('limit');
  if(raw!==null&&(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>50)) throw uiError('UI_JOB_LIMIT_INVALID');
  const cursor=url.searchParams.get('cursor');
  if(cursor!==null&&!validId(cursor)) throw uiError('UI_JOB_CURSOR_INVALID');
  return {limit:raw===null?20:Number(raw),cursor};
}
function requireScope(auth,value,projectId=null) {
  const scope=scopeOf({...value,projectId:projectId??value.projectId});
  if(auth.organizationId!==scope.organizationId||auth.projectId!==scope.projectId||(value.projectId!==undefined&&value.projectId!==scope.projectId)) throw uiError('UI_JOB_SCOPE_MISMATCH',403);
  return scope;
}
function badMethod(){throw uiError('UI_JOB_METHOD_NOT_ALLOWED',405);}
export async function uiRoute(request,env) {
  const url=new URL(request.url);
  const project=url.pathname.match(/^\/v1\/test-design-generation\/projects\/([^/]+)\/ui-jobs$/);
  const job=url.pathname.match(/^\/v1\/test-design-generation\/ui-jobs\/([^/]+)(?:\/(items|cancel))?$/);
  const readiness=url.pathname==='/v1/test-design-generation/ui-readiness';
  if(!project&&!job&&!readiness) return null;
  const rawBody=request.method==='POST'?await request.text():'';
  if(new TextEncoder().encode(rawBody).byteLength>64*1024) throw uiError('UI_JOB_REQUEST_TOO_LARGE',413);
  const auth=await verifyInternalRequest(request,env,{rawBody});
  let input={};
  try{input=rawBody?JSON.parse(rawBody):{};}catch{throw uiError('INVALID_JSON');}
  if(!input||typeof input!=='object'||Array.isArray(input)) throw uiError('UI_JOB_INPUT_INVALID');
  const query=Object.fromEntries(url.searchParams);
  const repo=uiRepository(env);
  if(readiness){
    if(request.method!=='GET') badMethod();
    requireScope(auth,query);
    const schemaReady=await repo.ready();
    const queueReady=Boolean(env?.TEST_DESIGN_GENERATION_QUEUE?.send);
    const gatewayReady=Boolean(env?.TEST_DESIGN_GENERATION_SERVICE?.fetch);
    const ready=schemaReady&&queueReady&&gatewayReady;
    return {status:ready?200:503,body:{status:ready?'ok':'error',code:ready?undefined:'UI_JOB_NOT_READY',data:{domain:'UI',ready,schemaReady,queueReady,gatewayReady,migration:'0003_ui_test_design_jobs.sql',executionPerformed:false}}};
  }
  if(!await repo.ready()) throw uiError('UI_JOB_SCHEMA_NOT_READY',503,false);
  if(project){
    const projectId=decodeURIComponent(project[1]);
    if(request.method==='POST'){
      const scope=requireScope(auth,input,projectId);
      const result=await createUiJob(env,scope,input,{repo});
      return {status:result.reused?200:202,body:{status:'ok',data:result}};
    }
    if(request.method==='GET'){
      const scope=requireScope(auth,query,projectId);
      return {status:200,body:{status:'ok',data:{...scope,...await repo.listJobs(scope,pagination(url)),executionPerformed:false}}};
    }
    badMethod();
  }
  const jobId=decodeURIComponent(job[1]);
  if(!validId(jobId)) throw uiError('UI_JOB_ID_INVALID');
  if(job[2]==='cancel'){
    if(request.method!=='POST') badMethod();
    const combined={...query,...input};
    for(const key of ['organizationId','projectId','environmentId']) if(query[key]!==undefined&&input[key]!==undefined&&query[key]!==input[key]) throw uiError('UI_JOB_SCOPE_MISMATCH',403);
    const scope=requireScope(auth,combined);
    const result=await repo.cancel(scope,jobId);
    await dispatchUiWork(env,repo,{jobId});
    return {status:200,body:{status:'ok',data:result}};
  }
  if(request.method!=='GET') badMethod();
  const scope=requireScope(auth,query);
  return {status:200,body:{status:'ok',data:job[2]==='items'?await repo.listItems(scope,jobId,pagination(url)):await repo.publicJob(scope,jobId)}};
}
