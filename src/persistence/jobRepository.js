import { durationMs, emitMetric } from '../lib/metrics.js';
import { OrchestratorError } from '../lib/errors.js';
import { deriveJobStatus } from '../jobs/progress.js';

function dbOf(env) {
  const db = env?.TEST_GENERATION_DB;
  if (!db?.prepare) throw new OrchestratorError('JOB_PERSISTENCE_FAILED', 'TEST_GENERATION_DB binding is unavailable.', { status: 503, retryable: true });
  return db;
}
function parseJson(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function mapJob(row) {
  if (!row) return null;
  return {
    jobId: row.job_id, organizationId: row.organization_id, projectId: row.project_id, scope: row.scope, status: row.status,
    endpointCount: Number(row.endpoint_count || 0), pendingCount: Number(row.pending_count || 0), queuedCount: Number(row.queued_count || 0),
    runningCount: Number(row.running_count || 0), succeededCount: Number(row.succeeded_count || 0), failedCount: Number(row.failed_count || 0), skippedCount: Number(row.skipped_count || 0),
    catalogEndpointCount: Number(row.catalog_endpoint_count || 0), existingTestDesignCount: Number(row.existing_test_design_count || 0), eligibleCount: Number(row.eligible_count || 0), ineligibleCount: Number(row.ineligible_count || 0),
    preflight: parseJson(row.preflight_json, {}), maxAttemptsPerEndpoint: Number(row.max_attempts_per_endpoint || 0), maxConcurrency: Number(row.max_concurrency || 0),
    createdBy: row.created_by || null, createdByAccountId: row.created_by_account_id || null,
    structuralErrorCode: row.structural_error_code || null, structuralErrorMessageSafe: row.structural_error_message_safe || null,
    createdAt: row.created_at, startedAt: row.started_at || null, completedAt: row.completed_at || null, cancelledAt: row.cancelled_at || null, lastUpdatedAt: row.last_updated_at,
  };
}
function mapItem(row) {
  if (!row) return null;
  return {
    jobItemId: row.job_item_id, jobId: row.job_id, organizationId: row.organization_id, projectId: row.project_id, endpointId: row.endpoint_id,
    method: row.endpoint_method || null, path: row.endpoint_path || null, status: row.status,
    attemptCount: Number(row.attempt_count || 0), maxAttempts: Number(row.max_attempts || 0), generationRequestId: row.generation_request_id,
    testDesignId: row.test_design_id || null, testDesignVersionId: row.test_design_version_id || null, testDesignVersion: row.test_design_version == null ? null : Number(row.test_design_version),
    errorCode: row.error_code || null, errorMessageSafe: row.error_message_safe || null, retryable: Number(row.retryable || 0) === 1,
    queuedAt: row.queued_at || null, startedAt: row.started_at || null, lastAttemptAt: row.last_attempt_at || null, nextRetryAt: row.next_retry_at || null,
    completedAt: row.completed_at || null, createdAt: row.created_at, lastUpdatedAt: row.last_updated_at,
  };
}
export async function findActiveJob(env, { organizationId, projectId, scope }) {
  const row = await dbOf(env).prepare(`SELECT * FROM test_design_generation_jobs WHERE organization_id=? AND project_id=? AND scope=? AND status IN ('QUEUED','RUNNING') ORDER BY created_at DESC LIMIT 1`).bind(organizationId, projectId, scope).first();
  return mapJob(row);
}
export async function insertJob(env, job) {
  try {
    await dbOf(env).prepare(`INSERT INTO test_design_generation_jobs (
      job_id,organization_id,project_id,scope,status,endpoint_count,pending_count,queued_count,running_count,succeeded_count,failed_count,skipped_count,
      catalog_endpoint_count,existing_test_design_count,eligible_count,ineligible_count,preflight_json,max_attempts_per_endpoint,max_concurrency,created_by,created_by_account_id,created_at,last_updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      job.jobId,job.organizationId,job.projectId,job.scope,job.status,job.endpointCount,job.endpointCount,0,0,0,0,0,
      job.catalogEndpointCount,job.existingTestDesignCount,job.eligibleCount,job.ineligibleCount,JSON.stringify(job.preflight || {}),job.maxAttemptsPerEndpoint,job.maxConcurrency,job.createdBy || null,job.createdByAccountId || null,job.createdAt,job.createdAt,
    ).run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || ''))) {
      throw new OrchestratorError('PROJECT_TEST_DESIGN_GENERATION_ALREADY_RUNNING', 'A Project Test Design Generation job is already running for this project and scope.', { status: 409, retryable: false, cause: error });
    }
    throw new OrchestratorError('JOB_PERSISTENCE_FAILED', 'Project generation job could not be persisted.', { status: 503, retryable: true, cause: error });
  }
  return getJob(env, { organizationId: job.organizationId, jobId: job.jobId });
}
export async function insertJobItems(env, items, { batchSize = 50 } = {}) {
  const db = dbOf(env);
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const chunk = items.slice(offset, offset + batchSize);
    const statements = chunk.map((item) => db.prepare(`INSERT INTO test_design_generation_job_items (
      job_item_id,job_id,organization_id,project_id,endpoint_id,endpoint_method,endpoint_path,status,attempt_count,max_attempts,generation_request_id,retryable,created_at,last_updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      item.jobItemId,item.jobId,item.organizationId,item.projectId,item.endpointId,item.method || null,item.path || null,'PENDING',0,item.maxAttempts,item.generationRequestId,0,item.createdAt,item.createdAt,
    ));
    try { await db.batch(statements); }
    catch (error) { throw new OrchestratorError('JOB_PERSISTENCE_FAILED', 'Project generation job items could not be persisted.', { status: 503, retryable: true, cause: error }); }
  }
}
export async function markJobItemsQueued(env, { jobId, now }) {
  await dbOf(env).prepare(`UPDATE test_design_generation_job_items SET status='QUEUED', queued_at=COALESCE(queued_at,?), last_updated_at=? WHERE job_id=? AND status='PENDING'`).bind(now, now, jobId).run();
  return refreshJobProgress(env, { jobId, now });
}
export async function getJob(env, { organizationId, jobId }) {
  const row = await dbOf(env).prepare(`SELECT * FROM test_design_generation_jobs WHERE job_id=? AND organization_id=? LIMIT 1`).bind(jobId, organizationId).first();
  return mapJob(row);
}
export async function getJobInternal(env, { jobId }) {
  return mapJob(await dbOf(env).prepare(`SELECT * FROM test_design_generation_jobs WHERE job_id=? LIMIT 1`).bind(jobId).first());
}
export async function listJobs(env, { organizationId, projectId, limit = 20 }) {
  const response = await dbOf(env).prepare(`SELECT * FROM test_design_generation_jobs WHERE organization_id=? AND project_id=? ORDER BY created_at DESC LIMIT ?`).bind(organizationId, projectId, Math.min(Math.max(Number(limit)||20,1),100)).all();
  return (response.results || []).map(mapJob);
}
export async function listJobItems(env, { organizationId, jobId, limit = 500 }) {
  const job = await getJob(env, { organizationId, jobId });
  if (!job) return { job: null, items: [] };
  const response = await dbOf(env).prepare(`SELECT * FROM test_design_generation_job_items WHERE job_id=? AND organization_id=? ORDER BY created_at ASC, endpoint_id ASC LIMIT ?`).bind(jobId, organizationId, Math.min(Math.max(Number(limit)||500,1),2000)).all();
  return { job, items: (response.results || []).map(mapItem) };
}
export async function getJobItemInternal(env, { jobItemId }) {
  return mapItem(await dbOf(env).prepare(`SELECT * FROM test_design_generation_job_items WHERE job_item_id=? LIMIT 1`).bind(jobItemId).first());
}
export async function claimJobItem(env, { jobItemId, now }) {
  const db = dbOf(env);
  const result = await db.prepare(`UPDATE test_design_generation_job_items SET
    status='GENERATING', attempt_count=attempt_count+1, started_at=COALESCE(started_at,?), last_attempt_at=?, next_retry_at=NULL, error_code=NULL, error_message_safe=NULL, retryable=0, last_updated_at=?
    WHERE job_item_id=? AND status IN ('QUEUED','RETRY_WAIT') AND attempt_count < max_attempts`).bind(now, now, now, jobItemId).run();
  if (!result.meta?.changes) return null;
  return getJobItemInternal(env, { jobItemId });
}
export async function recoverStaleGeneratingItem(env, { jobItemId, cutoff, now }) {
  const result = await dbOf(env).prepare(`UPDATE test_design_generation_job_items SET status='RETRY_WAIT',error_code='QUEUE_REDELIVERY',error_message_safe='Previous generation claim expired before completion.',retryable=1,next_retry_at=?,last_updated_at=? WHERE job_item_id=? AND status='GENERATING' AND last_attempt_at <= ?`).bind(now,now,jobItemId,cutoff).run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function markItemSucceeded(env, { jobItemId, testDesignId, testDesignVersionId, testDesignVersion, now }) {
  await dbOf(env).prepare(`UPDATE test_design_generation_job_items SET status='SUCCEEDED',test_design_id=?,test_design_version_id=?,test_design_version=?,error_code=NULL,error_message_safe=NULL,retryable=0,next_retry_at=NULL,completed_at=?,last_updated_at=? WHERE job_item_id=? AND status='GENERATING'`).bind(testDesignId,testDesignVersionId,testDesignVersion,now,now,jobItemId).run();
}
export async function markItemRetryWait(env, { jobItemId, errorCode, errorMessageSafe, nextRetryAt, now }) {
  await dbOf(env).prepare(`UPDATE test_design_generation_job_items SET status='RETRY_WAIT',error_code=?,error_message_safe=?,retryable=1,next_retry_at=?,last_updated_at=? WHERE job_item_id=? AND status='GENERATING'`).bind(errorCode,errorMessageSafe,nextRetryAt,now,jobItemId).run();
}
export async function markItemFailed(env, { jobItemId, errorCode, errorMessageSafe, retryable = false, now }) {
  await dbOf(env).prepare(`UPDATE test_design_generation_job_items SET status='FAILED',error_code=?,error_message_safe=?,retryable=?,next_retry_at=NULL,completed_at=?,last_updated_at=? WHERE job_item_id=? AND status='GENERATING'`).bind(errorCode,errorMessageSafe,retryable?1:0,now,now,jobItemId).run();
}
export async function markJobStructuralFailed(env, { organizationId, jobId, code, message, now }) {
  await dbOf(env).prepare(`UPDATE test_design_generation_jobs SET status='FAILED',structural_error_code=?,structural_error_message_safe=?,completed_at=?,last_updated_at=? WHERE job_id=? AND organization_id=? AND status IN ('QUEUED','RUNNING')`).bind(code,message,now,now,jobId,organizationId).run();
  return getJob(env, { organizationId, jobId });
}
export async function refreshJobProgress(env, { jobId, now }) {
  const db = dbOf(env);
  const job = await getJobInternal(env, { jobId });
  if (!job || ['FAILED','CANCELLED'].includes(job.status)) return job;
  const row = await db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending_count,
    SUM(CASE WHEN status='QUEUED' THEN 1 ELSE 0 END) AS queued_count,
    SUM(CASE WHEN status='GENERATING' THEN 1 ELSE 0 END) AS running_count,
    SUM(CASE WHEN status='RETRY_WAIT' THEN 1 ELSE 0 END) AS retry_wait_count,
    SUM(CASE WHEN status='SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded_count,
    SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN status='SKIPPED' THEN 1 ELSE 0 END) AS skipped_count,
    SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) AS cancelled_count
    FROM test_design_generation_job_items WHERE job_id=?`).bind(jobId).first();
  const total = Number(row?.total || 0), pending = Number(row?.pending_count || 0), queued = Number(row?.queued_count || 0) + Number(row?.retry_wait_count || 0), running = Number(row?.running_count || 0), succeeded = Number(row?.succeeded_count || 0), failed = Number(row?.failed_count || 0), skipped = Number(row?.skipped_count || 0), cancelled = Number(row?.cancelled_count || 0);
  const retryWait = Number(row?.retry_wait_count || 0);
  const status = deriveJobStatus({ currentStatus: job.status, total, running, succeeded, failed, skipped, cancelled, retryWait });
  let startedAt = job.startedAt;
  let completedAt = job.completedAt;
  if (status === 'RUNNING') startedAt ||= now;
  if (status === 'COMPLETED' || status === 'COMPLETED_WITH_FAILURES') { startedAt ||= job.createdAt; completedAt ||= now; }
  await db.prepare(`UPDATE test_design_generation_jobs SET status=?,pending_count=?,queued_count=?,running_count=?,succeeded_count=?,failed_count=?,skipped_count=?,started_at=?,completed_at=?,last_updated_at=? WHERE job_id=?`).bind(status,pending,queued,running,succeeded,failed,skipped,startedAt,completedAt,now,jobId).run();
  if (!['COMPLETED','COMPLETED_WITH_FAILURES'].includes(job.status) && ['COMPLETED','COMPLETED_WITH_FAILURES'].includes(status)) {
    emitMetric(status === 'COMPLETED' ? 'jobs_completed' : 'jobs_completed_with_failures', { jobId, organizationId: job.organizationId, projectId: job.projectId, value: 1 });
    emitMetric('job_duration_ms', { jobId, organizationId: job.organizationId, projectId: job.projectId, value: durationMs(startedAt || job.createdAt, completedAt) });
  }
  return getJobInternal(env, { jobId });
}
