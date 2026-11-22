import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UiSQLiteD1 } from './helpers/ui-sqlite.mjs';
import { uiRepository } from '../src/ui/repository.js';
import { createUiJob, processUiMessage, recoverUiJobs } from '../src/ui/service.js';
import { DEFAULT_UI_PROFILE, LEGACY_DEFAULT_UI_PROFILE, UI_COMPILER_VERSION, UI_LEGACY_COMPILER_VERSION,
  normalizeUiJob, normalizeProfile, validateCompilation, hash, canonical, uiError, wakeFor } from '../src/ui/contracts.js';

const golden=JSON.parse(readFileSync(new URL('./fixtures/ui-test-design-compilation.v2.json',import.meta.url),'utf8'));
const legacy=JSON.parse(readFileSync(new URL('./fixtures/ui-test-design-compilation.v1.json',import.meta.url),'utf8'));
const scope=golden.source.scope;
function setup(){
  let time=Date.now();const db=new UiSQLiteD1();db.migrate('0003_ui_test_design_jobs.sql');const messages=[];
  const env={TEST_GENERATION_DB:db,TEST_DESIGN_GENERATION_QUEUE:{send:async m=>messages.push(m)},UI_MAX_ITEM_ATTEMPTS:'3',UI_MAX_CONCURRENCY:'1'};
  const repo=uiRepository(env,{clock:()=>time});return {db,env,repo,messages,tick:ms=>{time+=ms;},close:()=>db.close()};
}
const input=(overrides={})=>({...scope,operationId:'uitdop_observed',bundleVersionIds:[golden.source.bundleVersionId],...overrides});
const admitted=(c,overrides={})=>createUiJob(c.env,scope,input(overrides),{repo:c.repo});
const itemFor=async(c,job)=>(await c.repo.listItems(scope,job.jobId,{limit:50})).items[0];
const receipt=compilation=>({status:'persisted',domain:'UI',testDesignId:'uitd_observed',testDesignVersionId:'uitdv_observed',version:1,contentHash:compilation.specificationHash});
const step=(c,item,call)=>processUiMessage({body:wakeFor(item),ack(){},retry(){}},c.env,{repo:c.repo,call});

test('new UI jobs freeze v2 ALL_OBSERVED profile while explicit v1 remains usable',async()=>{
  const newest=await normalizeUiJob(input(),scope),old=await normalizeUiJob(input({compilerVersion:UI_LEGACY_COMPILER_VERSION}),scope);
  assert.equal(newest.compilerVersion,UI_COMPILER_VERSION);assert.deepEqual(newest.profile,DEFAULT_UI_PROFILE);
  assert.equal(old.compilerVersion,UI_LEGACY_COMPILER_VERSION);assert.deepEqual(old.profile,LEGACY_DEFAULT_UI_PROFILE);
  assert.notEqual(newest.requestHash,old.requestHash);
  for(const value of [{...DEFAULT_UI_PROFILE,maxChecks:1},{...DEFAULT_UI_PROFILE,coveragePolicy:'SAMPLE'},LEGACY_DEFAULT_UI_PROFILE])assert.throws(()=>normalizeProfile(value));
  assert.throws(()=>normalizeProfile(DEFAULT_UI_PROFILE,UI_LEGACY_COMPILER_VERSION));
  const c=setup();try{
    const a=await admitted(c);assert.equal(a.compilerVersion,UI_COMPILER_VERSION);
    assert.equal((await admitted(c)).reused,true);
    await assert.rejects(admitted(c,{compilerVersion:UI_LEGACY_COMPILER_VERSION}),{code:'UI_JOB_OPERATION_CONFLICT'});
  }finally{c.close();}
});

test('compact plan is persisted before publishing and no observed payload is inflated',async()=>{
  const c=setup();try{
    const job=await admitted(c),item=await itemFor(c,job),calls=[];
    const call=async(_env,stage,body)=>{calls.push({stage,body});return stage==='compile'?golden:receipt(body.compilation);};
    assert.equal((await step(c,item,call)).status,'COMPILED');
    const durable=await c.repo.getItem(item.jobItemId);assert.deepEqual(JSON.parse(durable.candidateJson),golden);
    assert.equal(JSON.parse(durable.candidateJson).specification.plan.selection,'ALL_OBSERVED');
    assert.equal(JSON.parse(durable.candidateJson).specification.assertions,undefined);
    assert.equal((await step(c,item,call)).status,'SUCCEEDED');
    assert.deepEqual(calls.map(x=>x.stage),['compile','publish']);
    assert.equal(calls[0].body.compilerVersion,UI_COMPILER_VERSION);assert.deepEqual(calls[0].body.profile,DEFAULT_UI_PROFILE);
    assert.equal((await c.repo.publicJob(scope,job.jobId)).counts.succeeded,1);
  }finally{c.close();}
});

test('existing legacy queued work keeps v1 and does not silently migrate on recovery',async()=>{
  const c=setup();try{
    const job=await admitted(c,{compilerVersion:UI_LEGACY_COMPILER_VERSION,profile:LEGACY_DEFAULT_UI_PROFILE}),item=await itemFor(c,job),calls=[];
    const call=async(_env,stage,body)=>{calls.push({stage,body});return stage==='compile'?legacy:receipt(body.compilation);};
    await recoverUiJobs(c.env,{repo:c.repo});assert.equal((await step(c,item,call)).status,'COMPILED');
    assert.equal((await step(c,item,call)).status,'SUCCEEDED');
    assert.equal(calls[0].body.compilerVersion,UI_LEGACY_COMPILER_VERSION);assert.deepEqual(calls[0].body.profile,LEGACY_DEFAULT_UI_PROFILE);
    assert.deepEqual(calls[1].body.compilation,legacy);
  }finally{c.close();}
});

test('v2 retries reconcile the identical saved candidate after publication acknowledgement is lost',async()=>{
  const c=setup();try{
    const job=await admitted(c),item=await itemFor(c,job),calls=[],writes=new Map();let lost=true;
    const call=async(_env,stage,body)=>{
      calls.push(stage);if(stage==='compile')return golden;
      const key=body.generationRequestId,bytes=canonical(body.compilation);
      if(writes.has(key))assert.equal(writes.get(key),bytes);else writes.set(key,bytes);
      if(lost){lost=false;throw uiError('UI_GATEWAY_TIMEOUT',504,true);}return {...receipt(body.compilation),status:'reused'};
    };
    await step(c,item,call);const before=await c.repo.getItem(item.jobItemId);
    assert.equal((await step(c,item,call)).status,'RETRY_WAIT');c.tick(30001);
    assert.equal((await step(c,item,call)).status,'SUCCEEDED');assert.deepEqual(calls,['compile','publish','publish']);
    assert.equal(writes.size,1);assert.equal((await c.repo.getItem(item.jobItemId)).candidateHash,before.candidateHash);
  }finally{c.close();}
});

test('v2 candidacy rejects schema downgrade, partial coverage, mismatched summary and tampered source',async()=>{
  const job={...scope,compilerVersion:UI_COMPILER_VERSION,profile:DEFAULT_UI_PROFILE},item={bundleVersionId:golden.source.bundleVersionId};
  await validateCompilation(golden,job,item);
  for(const mutate of [
    c=>{c.contractVersion='qagent.ui-test-design-compilation.v1';},
    c=>{c.compilerVersion=UI_LEGACY_COMPILER_VERSION;},
    c=>{c.specification.plan.sections.pop();},
    c=>{c.specification.plan.silentOmissionAllowed=true;},
    c=>{c.specification.plan.pendingCannotPass=false;},
    c=>{c.summary.coverage={...c.summary.coverage,actionsPlanned:123};},
    c=>{c.specification.profile.layoutTolerancePx=3;},
    c=>{c.source={...c.source,scope:{...scope,organizationId:'org_different'}};},
    c=>{c.specification.executionPerformed=true;},
  ]){const changed=structuredClone(golden);mutate(changed);changed.specificationHash=await hash(changed.specification);await assert.rejects(validateCompilation(changed,job,item));}
  await assert.rejects(validateCompilation({...golden,specificationHash:'f'.repeat(64)},job,item),{code:'UI_COMPILATION_HASH_MISMATCH'});
  await assert.rejects(validateCompilation({...golden,outcome:'NO_DESIGN',specification:null,specificationHash:null},job,item),{code:'UI_COMPILATION_INVALID'});
});
