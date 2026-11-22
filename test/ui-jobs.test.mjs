import test from 'node:test';
import assert from 'node:assert/strict';
import { UiSQLiteD1 } from './helpers/ui-sqlite.mjs';
import { uiRepository } from '../src/ui/repository.js';
import { createUiJob, processUiMessage, recoverUiJobs } from '../src/ui/service.js';
import { canonical, LEGACY_DEFAULT_UI_PROFILE as DEFAULT_UI_PROFILE, hash, normalizeUiJob, UI_LEGACY_COMPILER_VERSION as UI_COMPILER_VERSION, UI_LEGACY_COMPILATION_VERSION as UI_COMPILATION_VERSION, uiError, validateCompilation, wakeFor } from '../src/ui/contracts.js';
import { uiGatewayCall } from '../src/ui/gatewayClient.js';
import { buildInternalHeaders, verifyInternalRequest } from '../src/security/internalAuth.js';
import worker, { handleRequest } from '../src/index.js';

const scope={organizationId:'org_ui',projectId:'prj_ui',environmentId:'env_ui'};
const input=(overrides={})=>({...scope,operationId:'operation_one',compilerVersion:UI_COMPILER_VERSION,bundleVersionIds:['urbv_one'],...overrides});
function setup({migration=true,maxAttempts=3,concurrency=1}={}){
  let time=Date.now();const db=new UiSQLiteD1(),messages=[];
  if(migration)db.migrate('0003_ui_test_design_jobs.sql');
  const env={TEST_GENERATION_DB:db,TEST_GENERATION_INTERNAL_HMAC_SECRET:'test-only-ui-secret-'.padEnd(48,'x'),UI_MAX_ITEM_ATTEMPTS:String(maxAttempts),UI_MAX_CONCURRENCY:String(concurrency),TEST_DESIGN_GENERATION_QUEUE:{send:async body=>messages.push(body)}};
  const repo=uiRepository(env,{clock:()=>time});
  return {db,env,repo,messages,tick:ms=>{time+=ms;},now:()=>time,close:()=>db.close()};
}
async function admit(c,overrides={}){return createUiJob(c.env,scope,input(overrides),{repo:c.repo});}
async function items(c,job){return (await c.repo.listItems(scope,job.jobId,{limit:50})).items;}
async function compilationFor(payload,{noDesign=false}={}){
  const source={scope:{organizationId:payload.organizationId,projectId:payload.projectId,environmentId:payload.environmentId},captureId:'uic_fixture',bundleVersionId:payload.bundleVersionId,sourceHash:'a'.repeat(64),manifestHash:'b'.repeat(64)};
  const specification=noDesign?null:{contractVersion:'qagent.ui-test-design.v1',compilerVersion:payload.compilerVersion,scope:source.scope,source,profile:payload.profile,executionModes:['UI_REPLAY','UI_LIVE'],executionPerformed:false,assertions:[{operator:'ELEMENT_PRESENT',expected:true}],readiness:{UI_REPLAY:{status:'BLOCKED',reasonCodes:['FIXTURE_MISSING']},UI_LIVE:{status:'REQUIRES_CONFIGURATION',reasonCodes:['TARGET_REQUIRED']}}};
  return {contractVersion:UI_COMPILATION_VERSION,compilerVersion:payload.compilerVersion,outcome:noDesign?'NO_DESIGN':'COMPILED',source,specification,specificationHash:specification?await hash(specification):null,summary:{coverage:{checks:specification?1:0},limitations:[],reasonCodes:noDesign?['NO_SUPPORTED_CHECKPOINTS']:[]},executionPerformed:false};
}
const persisted=(payload,status='persisted')=>({status,domain:'UI',testDesignId:'uitd_one',testDesignVersionId:'uitdv_one',version:1,contentHash:payload.compilation.specificationHash});
function callback(log=[]){return async(_env,stage,payload)=>{log.push({stage,payload:structuredClone(payload)});return stage==='compile'?compilationFor(payload):persisted(payload);};}
async function step(c,item,call=callback()){
  let ack=0,retries=[];
  const out=await processUiMessage({body:wakeFor(item),ack(){ack++;},retry(options){retries.push(options);}},c.env,{repo:c.repo,call});
  return {...out,ack,retries};
}
async function signed(c,method,path,body){
  const url='https://orchestrator.invalid'+path,rawBody=body===undefined?'':JSON.stringify(body);
  const headers=await buildInternalHeaders({env:c.env,method,url,organizationId:scope.organizationId,projectId:scope.projectId,rawBody});
  return new Request(url,{method,headers:{...headers,'content-type':'application/json'},...(method==='POST'?{body:rawBody}:{})});
}
const query=`organizationId=${scope.organizationId}&projectId=${scope.projectId}&environmentId=${scope.environmentId}`;

test('UI migration is additive, repeatable and readiness fails closed before it',async()=>{
  const c=setup({migration:false});try{
    c.db.migrate('0001_test_design_generation_jobs.sql');c.db.migrate('0002_autonomous_learning.sql');
    c.db.raw.exec("INSERT INTO test_design_generation_jobs(job_id,organization_id,project_id,scope,status,created_at,last_updated_at) VALUES('legacy','org_old','prj_old','ALL_ENDPOINTS','COMPLETED','2026','2026')");
    assert.equal(await c.repo.ready(),false);
    await assert.rejects(admit(c),{code:'UI_JOB_SCHEMA_NOT_READY'});
    c.db.migrate('0003_ui_test_design_jobs.sql');c.db.migrate('0003_ui_test_design_jobs.sql');
    assert.equal(await c.repo.ready(),true);
    assert.equal(c.db.raw.prepare('SELECT COUNT(*) n FROM test_design_generation_jobs').get().n,1);
    assert.deepEqual(await recoverUiJobs(c.env,{repo:c.repo}),{ready:true,queued:0,deferred:0});
  }finally{c.close();}
});
test('admission normalizes deduplicated source order and profile; same operation reuses durable job',async()=>{
  const c=setup();try{
    const a=await admit(c,{bundleVersionIds:['urbv_two','urbv_one','urbv_two'],profile:{},createdBy:'usr_a'});
    const b=await admit(c,{bundleVersionIds:['urbv_one','urbv_two'],profile:DEFAULT_UI_PROFILE,createdBy:'usr_b'});
    assert.equal(a.reused,false);assert.equal(b.reused,true);assert.equal(a.jobId,b.jobId);assert.equal(a.requestHash,b.requestHash);
    assert.deepEqual(a.bundleVersionIds,['urbv_one','urbv_two']);assert.deepEqual(a.profile,DEFAULT_UI_PROFILE);
    assert.equal((await items(c,a)).length,2);assert.equal(c.messages.length,2);
    await assert.rejects(admit(c,{bundleVersionIds:['urbv_other']}),{code:'UI_JOB_OPERATION_CONFLICT'});
    await assert.rejects(admit(c,{profile:{...DEFAULT_UI_PROFILE,layoutTolerancePx:3}}),{code:'UI_JOB_OPERATION_CONFLICT'});
    const restored=uiRepository(c.env,{clock:c.now});assert.equal((await restored.publicJob(scope,a.jobId)).jobId,a.jobId);
  }finally{c.close();}
});
test('snapshot rejects unsupported input, source overflow and cross-scope authority',async()=>{
  const cases=[input({bundleVersionIds:[]}),input({bundleVersionIds:Array.from({length:51},(_,i)=>'urbv_'+i)}),input({compilerVersion:'future'}),input({profile:{revision:1}}),input({profile:{...DEFAULT_UI_PROFILE,secret:'x'}}),input({organizationId:'org_other'}),input({extra:'unknown'})];
  for(const value of cases)await assert.rejects(normalizeUiJob(value,scope));
});
test('job and full bounded source snapshot are one transaction',async()=>{
  const c=setup();try{
    c.db.raw.exec("CREATE TRIGGER refuse_ui_item BEFORE INSERT ON ui_test_design_job_items BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    await assert.rejects(admit(c),{code:'UI_JOB_PERSISTENCE_FAILED'});
    assert.equal(c.db.raw.prepare('SELECT COUNT(*) n FROM ui_test_design_jobs').get().n,0);assert.equal(c.messages.length,0);
  }finally{c.close();}
});
test('durable admission survives queue outage and cron recovers only existing items',async()=>{
  const c=setup();try{
    c.env.TEST_DESIGN_GENERATION_QUEUE.send=async()=>{throw Error('queue down');};
    const job=await admit(c);assert.equal(job.status,'QUEUED');assert.equal(job.dispatch.deferred,1);
    c.env.TEST_DESIGN_GENERATION_QUEUE.send=async body=>c.messages.push(body);
    assert.equal((await recoverUiJobs(c.env,{repo:c.repo})).queued,1);
    assert.equal(c.messages.length,1);assert.equal(c.messages[0].jobId,job.jobId);
    assert.equal(c.db.raw.prepare('SELECT COUNT(*) n FROM ui_test_design_jobs').get().n,1);
  }finally{c.close();}
});
test('compilation is durable before publication and needs no AI/provider configuration',async()=>{
  const c=setup();try{
    const job=await admit(c),[item]=await items(c,job),calls=[];
    const call=async(_env,stage,payload)=>{
      calls.push(stage);
      assert.equal(payload.generationRequestId,'uitdg_'+item.jobItemId);
      if(stage==='compile')return compilationFor(payload);
      const row=await c.repo.getItem(item.jobItemId);assert.ok(row.candidateSavedAt);assert.ok(row.candidateHash);assert.equal(row.stage,'PUBLISH');
      return persisted(payload);
    };
    assert.equal((await step(c,item,call)).status,'COMPILED');assert.equal(calls.length,1);
    assert.equal((await step(c,item,call)).status,'SUCCEEDED');assert.deepEqual(calls,['compile','publish']);
    const result=await c.repo.publicJob(scope,job.jobId);assert.equal(result.status,'COMPLETED');assert.equal(result.executionPerformed,false);assert.equal(result.counts.succeeded,1);
    assert.equal(c.db.raw.prepare('SELECT COUNT(*) n FROM ui_test_design_job_attempts').get().n,2);
    assert.equal((await step(c,item,call)).reason,'UI_ITEM_TERMINAL');assert.equal(calls.length,2);
  }finally{c.close();}
});
test('lost Registry ACK reconciles same bytes and operation without recompiling or adding a version',async()=>{
  const c=setup();try{
    const job=await admit(c),[item]=await items(c,job),writes=new Map(),calls=[];let lost=true;
    const call=async(_env,stage,payload)=>{
      calls.push(stage);if(stage==='compile')return compilationFor(payload);
      const prior=writes.get(payload.generationRequestId),value=canonical(payload.compilation);
      if(prior)assert.equal(prior,value);else writes.set(payload.generationRequestId,value);
      if(lost){lost=false;throw uiError('UI_GATEWAY_TIMEOUT',504,true);}
      return persisted(payload,prior?'reused':'persisted');
    };
    await step(c,item,call);const before=await c.repo.getItem(item.jobItemId);
    assert.equal((await step(c,item,call)).status,'RETRY_WAIT');assert.equal((await c.repo.getItem(item.jobItemId)).publicationUncertain,true);
    c.tick(30001);assert.equal((await step(c,item,call)).status,'SUCCEEDED');
    assert.deepEqual(calls,['compile','publish','publish']);assert.equal(writes.size,1);
    const after=await c.repo.getItem(item.jobItemId);assert.equal(after.candidateHash,before.candidateHash);assert.equal(after.publicationUncertain,false);assert.equal(after.result.status,'reused');
  }finally{c.close();}
});
test('crash after candidate commit recovers checkpoint rather than repeating compiler',async()=>{
  const c=setup();try{
    const job=await admit(c),[item]=await items(c,job),calls=[],save=c.repo.saveCandidate;
    c.repo.saveCandidate=async(...args)=>{await save(...args);throw uiError('UI_JOB_TEMPORARY_FAILURE',503,true);};
    const first=await step(c,item,callback(calls));assert.equal(first.status,'FENCED');
    c.repo.saveCandidate=save;assert.equal((await c.repo.getItem(item.jobItemId)).status,'COMPILED');
    await recoverUiJobs(c.env,{repo:c.repo});await step(c,item,callback(calls));
    assert.deepEqual(calls.map(x=>x.stage),['compile','publish']);
  }finally{c.close();}
});
test('expired lease fences late compiler commits, failure writes and next claim',async()=>{
  const c=setup();try{
    const job=await admit(c),[item]=await items(c,job),old=await c.repo.claim(item.jobItemId);
    assert.equal(await c.repo.claim(item.jobItemId),null);
    const comp=await compilationFor({...scope,bundleVersionId:item.bundleVersionId,compilerVersion:job.compilerVersion,profile:job.profile});
    const candidate=await validateCompilation(comp,job,item);
    c.tick(240001);const current=await c.repo.claim(item.jobItemId);assert.ok(current);
    assert.equal(await c.repo.saveCandidate(old.item,candidate),null);
    assert.equal(await c.repo.fail(old.item,job,{code:'LATE',retryable:false,delaySeconds:0}),null);
    assert.ok(await c.repo.saveCandidate(current.item,candidate));
    assert.equal(c.db.raw.prepare("SELECT status FROM ui_test_design_job_attempts WHERE job_item_id=? AND revision=?").get(item.jobItemId,old.item.revision).status,'LEASE_EXPIRED');
  }finally{c.close();}
});
test('claim capacity and retry deadlines prevent duplicate work without consuming attempts',async()=>{
  const c=setup();try{
    const job=await admit(c,{bundleVersionIds:['urbv_a','urbv_b']}),[a,b]=await items(c,job),claim=await c.repo.claim(a.jobItemId);
    assert.equal(await c.repo.claim(b.jobItemId),null);assert.equal((await c.repo.getItem(b.jobItemId)).compileAttempts,0);
    await c.repo.fail(claim.item,job,{code:'UI_GATEWAY_TIMEOUT',retryable:true,delaySeconds:30});
    assert.equal(await c.repo.claim(a.jobItemId),null);assert.equal((await c.repo.getItem(a.jobItemId)).compileAttempts,1);
    assert.ok(await c.repo.claim(b.jobItemId));
  }finally{c.close();}
});
test('repeated worker loss exhausts durable attempts instead of restarting the retry budget',async()=>{
  const c=setup({maxAttempts:2});try{
    const job=await admit(c),[item]=await items(c,job);
    assert.ok(await c.repo.claim(item.jobItemId));c.tick(240001);assert.ok(await c.repo.claim(item.jobItemId));c.tick(240001);
    assert.equal(await c.repo.claim(item.jobItemId),null);
    const final=await c.repo.getItem(item.jobItemId);assert.equal(final.status,'FAILED');assert.equal(final.compileAttempts,2);
    assert.equal((await c.repo.publicJob(scope,job.jobId)).status,'FAILED');
  }finally{c.close();}
});
test('retryable failures are bounded per phase and preserve stage history',async()=>{
  const c=setup({maxAttempts:2});try{
    const job=await admit(c),[item]=await items(c,job);let calls=0;
    const failing=async()=>{calls++;throw uiError('UI_GATEWAY_UNAVAILABLE',503,true);};
    assert.equal((await step(c,item,failing)).status,'RETRY_WAIT');c.tick(30001);
    assert.equal((await step(c,item,failing)).status,'FAILED');assert.equal(calls,2);
    await step(c,item,failing);assert.equal(calls,2);
    assert.equal(c.db.raw.prepare("SELECT COUNT(*) n FROM ui_test_design_job_attempts WHERE status='FAILED'").get().n,1);
  }finally{c.close();}
});
test('permanent source failure is isolated while another item compiles and persists',async()=>{
  const c=setup();try{
    const job=await admit(c,{bundleVersionIds:['urbv_bad','urbv_good']}),all=await items(c,job),bad=all.find(i=>i.bundleVersionId==='urbv_bad'),good=all.find(i=>i.bundleVersionId==='urbv_good');
    assert.equal((await step(c,bad,async()=>{throw uiError('UI_SOURCE_REVOKED',410,false);})).status,'FAILED');
    await step(c,good);await step(c,good);
    const final=await c.repo.publicJob(scope,job.jobId);assert.equal(final.status,'COMPLETED_WITH_FAILURES');assert.equal(final.counts.succeeded,1);assert.equal(final.counts.failed,1);
  }finally{c.close();}
});
test('NO_DESIGN is terminal and diagnostic, never publication or test PASS',async()=>{
  const c=setup();try{
    const job=await admit(c),[item]=await items(c,job);let calls=0;
    const result=await step(c,item,async(_env,stage,payload)=>{calls++;assert.equal(stage,'compile');return compilationFor(payload,{noDesign:true});});
    assert.equal(result.status,'NO_DESIGN');assert.equal(calls,1);
    const [out]=await items(c,job);assert.deepEqual(out.summary.reasonCodes,['NO_SUPPORTED_CHECKPOINTS']);assert.equal(out.result,null);assert.equal(out.executionPerformed,false);
    assert.equal((await c.repo.publicJob(scope,job.jobId)).counts.noDesign,1);
  }finally{c.close();}
});
test('compiler hash/scope mismatches are permanent and no candidate is published',async()=>{
  for(const kind of ['hash','scope','profile','modes']){
    const c=setup();try{
      const job=await admit(c),[item]=await items(c,job);
      const result=await step(c,item,async(_env,_stage,payload)=>{const comp=await compilationFor(payload);if(kind==='hash')comp.specificationHash='0'.repeat(64);if(kind==='scope')comp.source.scope.environmentId='env_other';if(kind==='profile')comp.specification.profile={...comp.specification.profile,layoutTolerancePx:4};if(kind==='modes')comp.specification.executionModes=['UI_REPLAY'];return comp;});
      assert.equal(result.status,'FAILED');const row=await c.repo.getItem(item.jobItemId);assert.equal(row.candidateJson,null);assert.equal(row.publishAttempts,0);
    }finally{c.close();}
  }
});
test('tampered durable candidate is rejected before append callback',async()=>{
  const c=setup();try{
    const job=await admit(c),[item]=await items(c,job);await step(c,item);
    c.db.raw.prepare('UPDATE ui_test_design_job_items SET candidate_hash=? WHERE job_item_id=?').run('0'.repeat(64),item.jobItemId);
    const out=await step(c,item,async()=>{assert.fail('append must not be invoked');});assert.equal(out.code,'UI_CANDIDATE_HASH_MISMATCH');assert.equal(out.status,'FAILED');
  }finally{c.close();}
});
test('cancel queued or compiled work prevents any new publication and fences running compile',async()=>{
  const c=setup();try{
    const job=await admit(c,{bundleVersionIds:['urbv_a','urbv_b']}),[a,b]=await items(c,job);await step(c,a);
    const result=await step(c,b,async(_env,_stage,payload)=>{await c.repo.cancel(scope,job.jobId);return compilationFor(payload);});
    assert.equal(result.status,'FENCED');const final=await c.repo.publicJob(scope,job.jobId);assert.equal(final.status,'CANCELLED');assert.equal(final.counts.cancelled,2);
    assert.ok((await c.repo.getItem(a.jobItemId)).candidateJson);
    await step(c,a,async()=>assert.fail('cancelled item called gateway'));
    assert.equal((await c.repo.cancel(scope,job.jobId)).status,'CANCELLED');
  }finally{c.close();}
});
test('cancel keeps admitted publish reconciliation and immutable results',async()=>{
  const c=setup();try{
    const job=await admit(c),[item]=await items(c,job);await step(c,item);let once=true;
    const call=async(_env,stage,payload)=>{assert.equal(stage,'publish');if(once){once=false;await c.repo.cancel(scope,job.jobId);throw uiError('UI_GATEWAY_TIMEOUT',504,true);}return persisted(payload,'reused');};
    assert.equal((await step(c,item,call)).status,'RETRY_WAIT');assert.equal((await c.repo.publicJob(scope,job.jobId)).status,'CANCELLING');
    c.tick(30001);assert.equal((await step(c,item,call)).status,'SUCCEEDED');
    const final=await c.repo.publicJob(scope,job.jobId);assert.equal(final.status,'CANCELLED');assert.equal(final.counts.succeeded,1);assert.ok((await c.repo.getItem(item.jobItemId)).result);
  }finally{c.close();}
});
test('poisoned wake, cross-environment readers and foreign cursors cannot cross scope',async()=>{
  const c=setup();try{
    const job=await admit(c,{bundleVersionIds:['urbv_a','urbv_b','urbv_c']}),[item]=await items(c,job);let ack=0;
    const out=await processUiMessage({body:{...wakeFor(item),environmentId:'env_other'},ack(){ack++;}},c.env,{repo:c.repo,call:async()=>assert.fail('scope')});
    assert.equal(out.reason,'UI_WAKE_SCOPE_MISMATCH');assert.equal(ack,1);
    await assert.rejects(c.repo.publicJob({...scope,environmentId:'env_other'},job.jobId),{code:'UI_JOB_NOT_FOUND'});
    const first=await c.repo.listItems(scope,job.jobId,{limit:2});const second=await c.repo.listItems(scope,job.jobId,{limit:2,cursor:first.nextCursor});
    assert.equal(first.items.length,2);assert.equal(second.items.length,1);assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.items,...second.items].map(i=>i.jobItemId)).size,3);
    assert.equal('candidateJson' in first.items[0],false);assert.equal('leaseOwner' in first.items[0],false);
    await assert.rejects(c.repo.listItems(scope,job.jobId,{cursor:'foreign'}),{code:'UI_JOB_CURSOR_INVALID'});
  }finally{c.close();}
});
test('signed UI routes cover readiness, bounded list, item read, idempotent creation and cancellation',async()=>{
  const c=setup();try{
    c.env.TEST_DESIGN_GENERATION_SERVICE={fetch:async()=>assert.fail('HTTP admission cannot compile')};
    let response=await handleRequest(await signed(c,'GET','/v1/test-design-generation/ui-readiness?'+query),c.env);assert.equal(response.status,200);assert.equal((await response.json()).data.schemaReady,true);
    const path=`/v1/test-design-generation/projects/${scope.projectId}/ui-jobs`;
    response=await handleRequest(await signed(c,'POST',path,input()),c.env);assert.equal(response.status,202);const job=(await response.json()).data;
    response=await handleRequest(await signed(c,'POST',path,input()),c.env);assert.equal(response.status,200);assert.equal((await response.json()).data.reused,true);
    for(const target of [path+'?'+query,`/v1/test-design-generation/ui-jobs/${job.jobId}?${query}`,`/v1/test-design-generation/ui-jobs/${job.jobId}/items?${query}&limit=1`])assert.equal((await handleRequest(await signed(c,'GET',target),c.env)).status,200);
    response=await handleRequest(await signed(c,'GET',`/v1/test-design-generation/ui-jobs/${job.jobId}?organizationId=org_ui&projectId=prj_ui`),c.env);assert.equal(response.status,400);
    response=await handleRequest(await signed(c,'GET',`/v1/test-design-generation/ui-jobs/${job.jobId}?${query.replace('env_ui','env_other')}`),c.env);assert.equal(response.status,404);
    response=await handleRequest(await signed(c,'POST',`/v1/test-design-generation/ui-jobs/${job.jobId}/cancel`,scope),c.env);assert.equal((await response.json()).data.status,'CANCELLED');
  }finally{c.close();}
});
test('existing HMAC covers UI body and query scope; changed values are unauthorized',async()=>{
  const c=setup();try{
    const original=await signed(c,'GET','/v1/test-design-generation/ui-readiness?'+query);
    const tampered=new Request(original.url.replace('env_ui','env_other'),{headers:original.headers});
    assert.equal((await handleRequest(tampered,c.env)).status,401);
    const path=`/v1/test-design-generation/projects/${scope.projectId}/ui-jobs`;
    const signedBody=await signed(c,'POST',path,input());
    const changed=new Request(signedBody.url,{method:'POST',headers:signedBody.headers,body:JSON.stringify(input({operationId:'changed'}))});
    assert.equal((await handleRequest(changed,c.env)).status,401);
  }finally{c.close();}
});
test('Gateway callback uses existing signing, internal binding and standard response envelope',async()=>{
  const c=setup();try{
    let calls=0;const payload={...scope,jobId:'job',jobItemId:'item',generationRequestId:'uitdg_item',bundleVersionId:'urbv_one',compilerVersion:UI_COMPILER_VERSION,profile:DEFAULT_UI_PROFILE};
    const result=await uiGatewayCall(c.env,'compile',payload,{fetchImpl:async request=>{
      calls++;assert.equal(new URL(request.url).pathname,'/internal/v1/ui-test-design/compile');const body=await request.text();assert.deepEqual(await verifyInternalRequest(request,c.env,{rawBody:body}),{organizationId:scope.organizationId,projectId:scope.projectId});
      return Response.json({status:'ok',data:await compilationFor(JSON.parse(body))});
    }});
    assert.equal(result.outcome,'COMPILED');assert.equal(calls,1);
    await assert.rejects(uiGatewayCall(c.env,'publish',payload,{fetchImpl:async()=>Response.json({code:'UI_SOURCE_REVOKED',retryable:false},{status:410})}),{code:'UI_SOURCE_REVOKED',retryable:false});
  }finally{c.close();}
});
test('shared queue dispatches UI contract to deterministic callbacks and preserves unrelated queues',async()=>{
  const c=setup();try{
    const job=await admit(c);const paths=[];
    c.env.TEST_DESIGN_GENERATION_SERVICE={fetch:async request=>{
      const path=new URL(request.url).pathname;paths.push(path);const payload=await request.json();
      const data=path.endsWith('/compile')?await compilationFor(payload):persisted(payload);
      assert.ok(path.startsWith('/internal/v1/ui-test-design/'));return Response.json({status:'ok',data});
    }};
    for(let n=0;n<2;n++){const body=c.messages.shift();assert.ok(body);await worker.queue({queue:'qagent-test-design-generation',messages:[{body,ack(){},retry(){assert.fail('unexpected retry');}}]},c.env);}
    assert.deepEqual(paths,['/internal/v1/ui-test-design/compile','/internal/v1/ui-test-design/publish']);
    assert.equal((await c.repo.publicJob(scope,job.jobId)).counts.succeeded,1);
    await worker.queue({queue:'unknown',messages:[{body:{},ack(){assert.fail('unknown queue consumed');}}]},c.env);
  }finally{c.close();}
});
