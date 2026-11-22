import { boundedInt } from '../lib/config.js';
import { canonical, hash, uiError, UI_JOB_VERSION, TERMINAL_UI_ITEMS } from './contracts.js';

const iso = ms => new Date(ms).toISOString();
const changes = result => Number(result?.meta?.changes || 0);
const parse = text => text == null ? null : JSON.parse(text);
const scopeArgs = scope => [scope.organizationId,scope.projectId,scope.environmentId];
const scopeSql = 'organization_id=? AND project_id=? AND environment_id=?';
const publicItemColumns = `job_item_id,job_id,organization_id,project_id,environment_id,bundle_version_id,generation_request_id,status,stage,revision,compile_attempts,publish_attempts,wake_at,candidate_hash,specification_hash,candidate_saved_at,result_json,error_code,retryable,publication_uncertain,created_at,updated_at,completed_at,json_extract(candidate_json,'$.summary') AS summary_json,json_extract(candidate_json,'$.specification.readiness') AS readiness_json`;

function mapJob(row) {
  if (!row) return null;
  return { contractVersion: UI_JOB_VERSION,domain:'UI',jobId:row.job_id,
    organizationId:row.organization_id,projectId:row.project_id,environmentId:row.environment_id,
    operationId:row.operation_id,requestHash:row.request_hash,compilerVersion:row.compiler_version,
    profile:parse(row.profile_json),bundleVersionIds:parse(row.bundle_version_ids_json),status:row.status,
    itemCount:row.item_count,maxAttempts:row.max_attempts,maxConcurrency:row.max_concurrency,
    createdBy:row.created_by,createdByAccountId:row.created_by_account_id,
    createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at,cancelledAt:row.cancelled_at,
    executionPerformed:false };
}
function mapItem(row) {
  if (!row) return null;
  return { jobItemId:row.job_item_id,jobId:row.job_id,
    organizationId:row.organization_id,projectId:row.project_id,environmentId:row.environment_id,
    bundleVersionId:row.bundle_version_id,generationRequestId:row.generation_request_id,
    status:row.status,stage:row.stage,revision:row.revision,
    compileAttempts:row.compile_attempts,publishAttempts:row.publish_attempts,
    leaseOwner:row.lease_owner,leaseExpiresAt:row.lease_expires_at,wakeAt:row.wake_at,
    candidateJson:row.candidate_json,candidateHash:row.candidate_hash,specificationHash:row.specification_hash,
    candidateSavedAt:row.candidate_saved_at,result:parse(row.result_json),
    errorCode:row.error_code,retryable:row.retryable===1,publicationUncertain:row.publication_uncertain===1,
    summary:parse(row.summary_json),readiness:parse(row.readiness_json),
    createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at };
}
export function publicUiItem(item) {
  const { leaseOwner,leaseExpiresAt,candidateJson,revision,...result } = item;
  return { ...result,executionPerformed:false };
}

/** Every mutable item commit is fenced by revision, lease token and expiry.
 * External append uses its own stable operation ID: a lease is not exactly-once HTTP. */
export function uiRepository(env, { clock = () => Date.now() } = {}) {
  const db = env?.TEST_GENERATION_DB;
  if (!db?.prepare || !db?.batch) throw uiError('UI_JOB_DB_NOT_CONFIGURED',503,true);
  const first = (sql,...args) => db.prepare(sql).bind(...args).first();
  const run = (sql,...args) => db.prepare(sql).bind(...args).run();
  const all = async (sql,...args) => (await db.prepare(sql).bind(...args).all()).results || [];
  const maxAttempts = boundedInt(env?.UI_MAX_ITEM_ATTEMPTS,5,1,10);
  const concurrency = boundedInt(env?.UI_MAX_CONCURRENCY,1,1,3);
  const leaseSeconds = boundedInt(env?.UI_ITEM_LEASE_SECONDS,240,180,600);
  const internalJob = async id => mapJob(await first('SELECT * FROM ui_test_design_jobs WHERE job_id=?',id));
  const getJob = async (scope,id) => mapJob(await first(`SELECT * FROM ui_test_design_jobs WHERE job_id=? AND ${scopeSql}`,id,...scopeArgs(scope)));
  const getItem = async id => mapItem(await first('SELECT * FROM ui_test_design_job_items WHERE job_item_id=?',id));
  async function ready() {
    try {
      await first('SELECT job_id,operation_id,profile_json FROM ui_test_design_jobs LIMIT 0');
      await first('SELECT job_item_id,candidate_hash,lease_owner,publication_uncertain FROM ui_test_design_job_items LIMIT 0');
      await first('SELECT job_item_id,revision FROM ui_test_design_job_attempts LIMIT 0');
      return true;
    } catch { return false; }
  }
  async function create(definition) {
    if (!await ready()) throw uiError('UI_JOB_SCHEMA_NOT_READY',503,false);
    const previous = await first(`SELECT * FROM ui_test_design_jobs WHERE ${scopeSql} AND operation_id=?`,...scopeArgs(definition),definition.operationId);
    if (previous) {
      if (previous.request_hash !== definition.requestHash) throw uiError('UI_JOB_OPERATION_CONFLICT',409);
      return { job:mapJob(previous),reused:true };
    }
    const now = iso(clock());
    const jobId = 'uitdj_' + await hash([...scopeArgs(definition),definition.operationId]);
    const itemValues = await Promise.all(definition.bundleVersionIds.map(async bundleVersionId => {
      const jobItemId = 'uitdji_' + await hash([jobId,bundleVersionId]);
      return { jobItemId,bundleVersionId,generationRequestId:'uitdg_'+jobItemId };
    }));
    try {
      await db.batch([
        db.prepare(`INSERT INTO ui_test_design_jobs(job_id,organization_id,project_id,environment_id,operation_id,request_hash,compiler_version,profile_json,bundle_version_ids_json,status,item_count,max_attempts,max_concurrency,created_by,created_by_account_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'QUEUED',?,?,?,?,?,?,?)`).bind(jobId,...scopeArgs(definition),definition.operationId,definition.requestHash,definition.compilerVersion,canonical(definition.profile),canonical(definition.bundleVersionIds),itemValues.length,maxAttempts,concurrency,definition.createdBy,definition.createdByAccountId,now,now),
        db.prepare(`INSERT INTO ui_test_design_job_items(job_item_id,job_id,organization_id,project_id,environment_id,bundle_version_id,generation_request_id,status,stage,wake_at,created_at,updated_at)
          SELECT json_extract(value,'$.jobItemId'),?,?,?,?,json_extract(value,'$.bundleVersionId'),json_extract(value,'$.generationRequestId'),'PENDING','COMPILE',?,?,? FROM json_each(?)`).bind(jobId,...scopeArgs(definition),now,now,now,canonical(itemValues)),
      ]);
    } catch (error) {
      const replay = await getJob(definition,jobId);
      if (replay) {
        if (replay.requestHash !== definition.requestHash) throw uiError('UI_JOB_OPERATION_CONFLICT',409);
        return { job:replay,reused:true };
      }
      throw uiError('UI_JOB_PERSISTENCE_FAILED',503,true);
    }
    return { job:await getJob(definition,jobId),reused:false };
  }
  async function counts(jobId) {
    const rows = await all('SELECT status,COUNT(*) AS n FROM ui_test_design_job_items WHERE job_id=? GROUP BY status',jobId);
    const count = Object.fromEntries(rows.map(row=>[row.status,row.n]));
    return { total:rows.reduce((n,r)=>n+r.n,0),pending:count.PENDING||0,compiling:count.COMPILING||0,compiled:count.COMPILED||0,publishing:count.PUBLISHING||0,retryWaiting:count.RETRY_WAIT||0,succeeded:count.SUCCEEDED||0,noDesign:count.NO_DESIGN||0,failed:count.FAILED||0,cancelled:count.CANCELLED||0 };
  }
  async function publicJob(scope,id) {
    const job = await getJob(scope,id);
    if (!job) throw uiError('UI_JOB_NOT_FOUND',404);
    return { ...job,counts:await counts(id) };
  }
  async function listJobs(scope,{limit=20,cursor=null}={}) {
    let after = null;
    if (cursor) {
      after = await getJob(scope,cursor);
      if (!after) throw uiError('UI_JOB_CURSOR_INVALID',400);
    }
    const rows = await all(`SELECT * FROM ui_test_design_jobs WHERE ${scopeSql} ${after?'AND (created_at<? OR (created_at=? AND job_id<?))':''} ORDER BY created_at DESC,job_id DESC LIMIT ?`,...scopeArgs(scope),...(after?[after.createdAt,after.createdAt,after.jobId]:[]),limit+1);
    const jobs = await Promise.all(rows.slice(0,limit).map(async row=>({ ...mapJob(row),counts:await counts(row.job_id) })));
    return { jobs,nextCursor:rows.length>limit?jobs.at(-1).jobId:null };
  }
  async function listItems(scope,jobId,{limit=20,cursor=null}={}) {
    const job = await publicJob(scope,jobId);
    if (cursor && !await first('SELECT 1 FROM ui_test_design_job_items WHERE job_id=? AND job_item_id=?',jobId,cursor)) throw uiError('UI_JOB_CURSOR_INVALID',400);
    const rows = await all(`SELECT ${publicItemColumns} FROM ui_test_design_job_items WHERE job_id=? ${cursor?'AND job_item_id>?':''} ORDER BY job_item_id LIMIT ?`,jobId,...(cursor?[cursor]:[]),limit+1);
    const items = rows.slice(0,limit).map(row=>publicUiItem(mapItem(row)));
    const attempts=items.length?await all(`SELECT job_item_id,stage,attempt_number,status,error_code,started_at,completed_at FROM ui_test_design_job_attempts WHERE job_item_id IN (SELECT value FROM json_each(?)) ORDER BY job_item_id,revision`,canonical(items.map(item=>item.jobItemId))):[];
    for(const item of items)item.attempts=attempts.filter(row=>row.job_item_id===item.jobItemId).map(row=>({stage:row.stage,attempt:row.attempt_number,status:row.status,errorCode:row.error_code,startedAt:row.started_at,completedAt:row.completed_at}));
    return { job,items,nextCursor:rows.length>limit?items.at(-1).jobItemId:null };
  }
  async function refresh(jobId) {
    const now = iso(clock());
    // Derive from persisted items in the UPDATE itself, avoiding a stale aggregate
    // overwriting a terminal state while another worker commits a sibling.
    await run(`UPDATE ui_test_design_jobs SET status=CASE
      WHEN status='CANCELLING' THEN 'CANCELLED'
      WHEN (SELECT COUNT(*) FROM ui_test_design_job_items WHERE job_id=? AND status='FAILED')=item_count THEN 'FAILED'
      WHEN EXISTS(SELECT 1 FROM ui_test_design_job_items WHERE job_id=? AND status='FAILED') THEN 'COMPLETED_WITH_FAILURES'
      ELSE 'COMPLETED' END,completed_at=?,updated_at=?
      WHERE job_id=? AND status IN ('QUEUED','RUNNING','CANCELLING')
      AND NOT EXISTS(SELECT 1 FROM ui_test_design_job_items WHERE job_id=? AND status NOT IN ('SUCCEEDED','NO_DESIGN','FAILED','CANCELLED'))`,jobId,jobId,now,now,jobId,jobId);
    return internalJob(jobId);
  }
  const fenceSql = `job_item_id=? AND revision=? AND lease_owner=? AND lease_expires_at>? AND status IN ('COMPILING','PUBLISHING')`;
  const fenceArgs = (item,now=iso(clock())) => [item.jobItemId,item.revision,item.leaseOwner,now];
  async function claim(itemId) {
    const item = await getItem(itemId);
    if (!item || TERMINAL_UI_ITEMS.has(item.status)) return null;
    const job = await internalJob(item.jobId);
    const continuing = job?.status==='CANCELLING' && item.stage==='PUBLISH' && item.publishAttempts>0;
    if (!job || (!['QUEUED','RUNNING'].includes(job.status) && !continuing)) return null;
    const now = iso(clock());
    if (item.wakeAt>now || (item.leaseOwner && item.leaseExpiresAt>now)) return null;
    const attempts = item.stage==='COMPILE'?item.compileAttempts:item.publishAttempts;
    if (attempts>=job.maxAttempts) {
      await db.batch([
        db.prepare(`UPDATE ui_test_design_job_attempts SET status='LEASE_EXPIRED',error_code='UI_ITEM_LEASE_RETRIES_EXHAUSTED',completed_at=? WHERE job_item_id=? AND status='RUNNING' AND revision=?`).bind(now,itemId,item.revision),
        db.prepare(`UPDATE ui_test_design_job_items SET status='FAILED',stage='DONE',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,error_code='UI_ITEM_LEASE_RETRIES_EXHAUSTED',retryable=0,completed_at=?,updated_at=? WHERE job_item_id=? AND revision=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).bind(now,now,itemId,item.revision,now),
      ]);
      await refresh(item.jobId);
      return null;
    }
    const owner=crypto.randomUUID(), until=iso(clock()+leaseSeconds*1000);
    const result=await db.batch([
      db.prepare(`UPDATE ui_test_design_job_attempts SET status='LEASE_EXPIRED',completed_at=? WHERE job_item_id=? AND status='RUNNING' AND EXISTS(SELECT 1 FROM ui_test_design_job_items WHERE job_item_id=? AND revision=ui_test_design_job_attempts.revision AND lease_expires_at<=?)`).bind(now,itemId,itemId,now),
      db.prepare(`UPDATE ui_test_design_job_items SET status=CASE stage WHEN 'COMPILE' THEN 'COMPILING' ELSE 'PUBLISHING' END,revision=revision+1,lease_owner=?,lease_expires_at=?,compile_attempts=compile_attempts+CASE stage WHEN 'COMPILE' THEN 1 ELSE 0 END,publish_attempts=publish_attempts+CASE stage WHEN 'PUBLISH' THEN 1 ELSE 0 END,updated_at=?
        WHERE job_item_id=? AND revision=? AND wake_at<=? AND status NOT IN ('SUCCEEDED','NO_DESIGN','FAILED','CANCELLED') AND (lease_owner IS NULL OR lease_expires_at<=?)
        AND EXISTS(SELECT 1 FROM ui_test_design_jobs WHERE job_id=ui_test_design_job_items.job_id AND (status IN ('QUEUED','RUNNING') OR (status='CANCELLING' AND ui_test_design_job_items.stage='PUBLISH' AND ui_test_design_job_items.publish_attempts>0)))
        AND (SELECT COUNT(*) FROM ui_test_design_job_items WHERE status IN ('COMPILING','PUBLISHING') AND lease_expires_at>?)<?
        AND (SELECT COUNT(*) FROM ui_test_design_job_items WHERE job_id=? AND status IN ('COMPILING','PUBLISHING') AND lease_expires_at>?)<?`).bind(owner,until,now,itemId,item.revision,now,now,now,concurrency,item.jobId,now,job.maxConcurrency),
      db.prepare(`INSERT INTO ui_test_design_job_attempts(job_item_id,revision,stage,attempt_number,status,started_at)
        SELECT job_item_id,revision,stage,CASE stage WHEN 'COMPILE' THEN compile_attempts ELSE publish_attempts END,'RUNNING',? FROM ui_test_design_job_items WHERE job_item_id=? AND lease_owner=?`).bind(now,itemId,owner),
    ]);
    if (!changes(result[1])) return null;
    await run("UPDATE ui_test_design_jobs SET status='RUNNING',updated_at=? WHERE job_id=? AND status='QUEUED'",now,item.jobId);
    return { job:await internalJob(item.jobId),item:await getItem(itemId) };
  }
  async function saveCandidate(item,candidate) {
    const now=iso(clock()), noDesign=candidate.compilation.outcome==='NO_DESIGN';
    const guard=`${fenceSql} AND stage='COMPILE' AND candidate_json IS NULL`;
    const args=fenceArgs(item,now);
    const result=await db.batch([
      db.prepare(`UPDATE ui_test_design_job_attempts SET status=?,completed_at=? WHERE job_item_id=? AND revision=? AND EXISTS(SELECT 1 FROM ui_test_design_job_items WHERE ${guard})`).bind(noDesign?'NO_DESIGN':'SUCCEEDED',now,item.jobItemId,item.revision,...args),
      db.prepare(`UPDATE ui_test_design_job_items SET status=?,stage=?,candidate_json=?,candidate_hash=?,specification_hash=?,candidate_saved_at=?,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,wake_at=?,last_dispatched_at=NULL,error_code=NULL,retryable=0,completed_at=?,updated_at=? WHERE ${guard}`).bind(noDesign?'NO_DESIGN':'COMPILED',noDesign?'DONE':'PUBLISH',candidate.candidateJson,candidate.candidateHash,candidate.specificationHash,now,now,noDesign?now:null,now,...args),
    ]);
    return changes(result[1])?getItem(item.jobItemId):null;
  }
  async function completePublication(item,result) {
    const now=iso(clock());
    const guard=`${fenceSql} AND stage='PUBLISH' AND candidate_json IS NOT NULL`;
    const args=fenceArgs(item,now);
    const saved=await db.batch([
      db.prepare(`UPDATE ui_test_design_job_attempts SET status='SUCCEEDED',completed_at=? WHERE job_item_id=? AND revision=? AND EXISTS(SELECT 1 FROM ui_test_design_job_items WHERE ${guard})`).bind(now,item.jobItemId,item.revision,...args),
      db.prepare(`UPDATE ui_test_design_job_items SET status='SUCCEEDED',stage='DONE',result_json=?,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,publication_uncertain=0,error_code=NULL,retryable=0,completed_at=?,updated_at=? WHERE ${guard}`).bind(canonical(result),now,now,...args),
    ]);
    return changes(saved[1])?getItem(item.jobItemId):null;
  }
  async function fail(item,job,{code,retryable,delaySeconds}) {
    const attempt=item.stage==='COMPILE'?item.compileAttempts:item.publishAttempts;
    const retry=retryable && attempt<job.maxAttempts, now=iso(clock());
    const status=retry?'RETRY_WAIT':'FAILED';
    const args=fenceArgs(item,now);
    const saved=await db.batch([
      db.prepare(`UPDATE ui_test_design_job_attempts SET status=?,error_code=?,completed_at=? WHERE job_item_id=? AND revision=? AND EXISTS(SELECT 1 FROM ui_test_design_job_items WHERE ${fenceSql})`).bind(status,code,now,item.jobItemId,item.revision,...args),
      db.prepare(`UPDATE ui_test_design_job_items SET status=?,stage=CASE WHEN ? THEN stage ELSE 'DONE' END,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,wake_at=?,last_dispatched_at=NULL,error_code=?,retryable=?,completed_at=?,updated_at=? WHERE ${fenceSql}`).bind(status,retry?1:0,iso(clock()+delaySeconds*1000),code,retry?1:0,retry?null:now,now,...args),
    ]);
    return changes(saved[1])?getItem(item.jobItemId):null;
  }
  async function cancel(scope,id) {
    const job=await getJob(scope,id);
    if (!job) throw uiError('UI_JOB_NOT_FOUND',404);
    const now=iso(clock());
    // A publish already admitted may have committed externally. Complete its stable
    // idempotent operation, including reconciliation retries. Never start a new one.
    await db.batch([
      db.prepare(`UPDATE ui_test_design_jobs SET status='CANCELLING',cancelled_at=COALESCE(cancelled_at,?),updated_at=? WHERE job_id=? AND ${scopeSql} AND status IN ('QUEUED','RUNNING')`).bind(now,now,id,...scopeArgs(scope)),
      db.prepare(`UPDATE ui_test_design_job_attempts SET status='CANCELLED',completed_at=? WHERE status='RUNNING' AND job_item_id IN (SELECT job_item_id FROM ui_test_design_job_items WHERE job_id=? AND stage='COMPILE') AND EXISTS(SELECT 1 FROM ui_test_design_jobs WHERE job_id=? AND status='CANCELLING')`).bind(now,id,id),
      db.prepare(`UPDATE ui_test_design_job_items SET status='CANCELLED',stage='DONE',revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,completed_at=?,updated_at=? WHERE job_id=? AND status NOT IN ('SUCCEEDED','NO_DESIGN','FAILED','CANCELLED') AND NOT(stage='PUBLISH' AND publish_attempts>0) AND EXISTS(SELECT 1 FROM ui_test_design_jobs WHERE job_id=? AND status='CANCELLING')`).bind(now,now,id,id),
    ]);
    await refresh(id);
    return publicJob(scope,id);
  }
  async function due({jobId=null,limit=50}={}) {
    const now=iso(clock());
    return (await all(`SELECT i.job_item_id,i.job_id,i.organization_id,i.project_id,i.environment_id FROM ui_test_design_job_items i JOIN ui_test_design_jobs j ON j.job_id=i.job_id WHERE i.status NOT IN ('SUCCEEDED','NO_DESIGN','FAILED','CANCELLED') AND i.wake_at<=? AND (i.lease_owner IS NULL OR i.lease_expires_at<=?) AND (j.status IN ('QUEUED','RUNNING') OR (j.status='CANCELLING' AND i.stage='PUBLISH' AND i.publish_attempts>0)) AND (i.last_dispatched_at IS NULL OR i.last_dispatched_at<=?) ${jobId?'AND i.job_id=?':''} ORDER BY COALESCE(i.last_dispatched_at,i.created_at),i.job_item_id LIMIT ?`,now,now,iso(clock()-60000),...(jobId?[jobId]:[]),limit)).map(row=>({jobItemId:row.job_item_id,jobId:row.job_id,organizationId:row.organization_id,projectId:row.project_id,environmentId:row.environment_id}));
  }
  const dispatched = item => run('UPDATE ui_test_design_job_items SET last_dispatched_at=? WHERE job_item_id=? AND status NOT IN (\'SUCCEEDED\',\'NO_DESIGN\',\'FAILED\',\'CANCELLED\')',iso(clock()),item.jobItemId);
  async function refreshActive() {
    const rows=await all("SELECT job_id FROM ui_test_design_jobs j WHERE status IN ('QUEUED','RUNNING','CANCELLING') AND NOT EXISTS(SELECT 1 FROM ui_test_design_job_items i WHERE i.job_id=j.job_id AND i.status NOT IN ('SUCCEEDED','NO_DESIGN','FAILED','CANCELLED')) ORDER BY updated_at LIMIT 100");
    for (const row of rows) await refresh(row.job_id);
  }
  const isCurrent=async item=>Boolean(await first(`SELECT 1 FROM ui_test_design_job_items WHERE ${fenceSql}`,...fenceArgs(item)));
  const markPublicationStarted=async item=>Boolean(changes(await run(`UPDATE ui_test_design_job_items SET publication_uncertain=1 WHERE ${fenceSql} AND stage='PUBLISH' AND candidate_hash=?`,...fenceArgs(item),item.candidateHash)));
  return { ready,create,getJob,getItem,internalJob,publicJob,listJobs,listItems,claim,isCurrent,markPublicationStarted,saveCandidate,completePublication,fail,cancel,refresh,refreshActive,due,dispatched };
}
