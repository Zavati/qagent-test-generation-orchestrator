import { generateEndpointTestDesign } from '../clients/gatewayGenerationClient.js';
import { TERMINAL_JOB_STATUSES, TERMINAL_ITEM_STATUSES } from '../contracts/jobContracts.js';
import { safeErrorMessage } from '../lib/errors.js';
import { boundedInt } from '../lib/config.js';
import { durationMs, emitMetric } from '../lib/metrics.js';
import { claimJobItem, getJobInternal, getJobItemInternal, markItemFailed, markItemRetryWait, markItemSucceeded, recoverStaleGeneratingItem, refreshJobProgress } from '../persistence/jobRepository.js';
import { retryDelaySeconds } from '../retry/backoff.js';
import { classifyRetry } from '../retry/classifyRetry.js';
import { validateJobItemMessage } from './contracts.js';

function isoPlusSeconds(iso, seconds) { return new Date(new Date(iso).getTime() + seconds * 1000).toISOString(); }

export async function processJobItemMessage(message, env, { deps = {}, now = () => new Date().toISOString() } = {}) {
  const body = message?.body;
  if (!validateJobItemMessage(body)) { message?.ack?.(); return { ignored: true, reason: 'INVALID_MESSAGE' }; }
  const getJob = deps.getJob || getJobInternal;
  const getItem = deps.getItem || getJobItemInternal;
  const job = await getJob(env, { jobId: body.jobId });
  if (!job || job.organizationId !== body.organizationId || job.projectId !== body.projectId) { message?.ack?.(); return { ignored: true, reason: 'JOB_SCOPE_MISMATCH' }; }
  if (TERMINAL_JOB_STATUSES.has(job.status)) { message?.ack?.(); return { ignored: true, reason: 'JOB_TERMINAL' }; }
  const current = await getItem(env, { jobItemId: body.jobItemId });
  if (!current || current.jobId !== job.jobId || current.endpointId !== body.endpointId) { message?.ack?.(); return { ignored: true, reason: 'ITEM_SCOPE_MISMATCH' }; }
  if (TERMINAL_ITEM_STATUSES.has(current.status)) { message?.ack?.(); return { ignored: true, reason: 'ITEM_TERMINAL' }; }
  if (current.status === 'PENDING') { message?.retry?.({ delaySeconds: 1 }); return { ignored: true, reason: 'ITEM_NOT_PUBLISHED_YET' }; }
  const started = now();
  if (current.status === 'GENERATING') {
    const leaseSeconds = boundedInt(env?.ITEM_CLAIM_LEASE_SECONDS, 180, 60, 900);
    const lastAttemptMs = Date.parse(current.lastAttemptAt || current.startedAt || '');
    const startedMs = Date.parse(started);
    const stale = Number.isFinite(lastAttemptMs) && Number.isFinite(startedMs) && startedMs - lastAttemptMs >= leaseSeconds * 1000;
    if (!stale) { message?.retry?.({ delaySeconds: 5 }); return { ignored: true, reason: 'ITEM_ALREADY_CLAIMED' }; }
    if (current.attemptCount >= current.maxAttempts) {
      await (deps.markFailed || markItemFailed)(env, { jobItemId: current.jobItemId, errorCode: 'QUEUE_REDELIVERY', errorMessageSafe: 'Generation claim expired after the maximum number of attempts.', retryable: true, now: started });
      await (deps.refresh || refreshJobProgress)(env, { jobId: job.jobId, now: started });
      message?.ack?.();
      return { processed: true, status: 'FAILED', reason: 'STALE_CLAIM_EXHAUSTED' };
    }
    const recovered = await (deps.recoverStale || recoverStaleGeneratingItem)(env, { jobItemId: current.jobItemId, cutoff: new Date(startedMs - leaseSeconds * 1000).toISOString(), now: started });
    if (!recovered) { message?.retry?.({ delaySeconds: 5 }); return { ignored: true, reason: 'STALE_CLAIM_RECOVERY_RACE' }; }
  }

  const item = await (deps.claimItem || claimJobItem)(env, { jobItemId: current.jobItemId, now: started });
  if (!item) { message?.ack?.(); return { ignored: true, reason: 'CLAIM_LOST' }; }
  await (deps.refresh || refreshJobProgress)(env, { jobId: job.jobId, now: started });

  try {
    const result = await (deps.generate || generateEndpointTestDesign)({
      env, organizationId: job.organizationId, projectId: job.projectId, endpointId: item.endpointId,
      accountId: job.createdByAccountId, jobId: job.jobId, jobItemId: item.jobItemId, generationRequestId: item.generationRequestId,
    });
    const completed = now();
    await (deps.markSucceeded || markItemSucceeded)(env, {
      jobItemId: item.jobItemId, testDesignId: result.testDesignId, testDesignVersionId: result.testDesignVersionId, testDesignVersion: result.testDesignVersion, now: completed,
    });
    const finalJob = await (deps.refresh || refreshJobProgress)(env, { jobId: job.jobId, now: completed });
    message?.ack?.();
    console.log('project_test_design_generation_item_succeeded', { jobId: job.jobId, jobItemId: item.jobItemId, organizationId: job.organizationId, projectId: job.projectId, endpointId: item.endpointId, attemptNumber: item.attemptCount, status: 'SUCCEEDED' });
    emitMetric('items_succeeded', { jobId: job.jobId, jobItemId: item.jobItemId, endpointId: item.endpointId, value: 1 });
    emitMetric('item_duration_ms', { jobId: job.jobId, jobItemId: item.jobItemId, value: durationMs(started, completed) });
    emitMetric('attempt_count', { jobId: job.jobId, jobItemId: item.jobItemId, value: item.attemptCount });
    return { processed: true, status: 'SUCCEEDED', job: finalJob };
  } catch (error) {
    const completed = now();
    const classified = classifyRetry(error);
    const exhausted = item.attemptCount >= item.maxAttempts;
    const messageSafe = safeErrorMessage(error);
    if (classified.retryable && !exhausted) {
      const delaySeconds = retryDelaySeconds(item.attemptCount);
      await (deps.markRetryWait || markItemRetryWait)(env, { jobItemId: item.jobItemId, errorCode: classified.code, errorMessageSafe: messageSafe, nextRetryAt: isoPlusSeconds(completed, delaySeconds), now: completed });
      await (deps.refresh || refreshJobProgress)(env, { jobId: job.jobId, now: completed });
      message?.retry?.({ delaySeconds });
      console.log('project_test_design_generation_item_retry', { jobId: job.jobId, jobItemId: item.jobItemId, organizationId: job.organizationId, projectId: job.projectId, endpointId: item.endpointId, attemptNumber: item.attemptCount, status: 'RETRY_WAIT', errorCode: classified.code });
      emitMetric('items_retried', { jobId: job.jobId, jobItemId: item.jobItemId, endpointId: item.endpointId, value: 1 });
      emitMetric('retry_reason', { jobId: job.jobId, jobItemId: item.jobItemId, reason: classified.code, value: 1 });
      emitMetric('item_duration_ms', { jobId: job.jobId, jobItemId: item.jobItemId, value: durationMs(started, completed) });
      return { processed: true, status: 'RETRY_WAIT', delaySeconds };
    }
    await (deps.markFailed || markItemFailed)(env, { jobItemId: item.jobItemId, errorCode: classified.code, errorMessageSafe: messageSafe, retryable: classified.retryable, now: completed });
    const finalJob = await (deps.refresh || refreshJobProgress)(env, { jobId: job.jobId, now: completed });
    message?.ack?.();
    console.log('project_test_design_generation_item_failed', { jobId: job.jobId, jobItemId: item.jobItemId, organizationId: job.organizationId, projectId: job.projectId, endpointId: item.endpointId, attemptNumber: item.attemptCount, status: 'FAILED', errorCode: classified.code });
    emitMetric('items_failed', { jobId: job.jobId, jobItemId: item.jobItemId, endpointId: item.endpointId, value: 1 });
    emitMetric('item_duration_ms', { jobId: job.jobId, jobItemId: item.jobItemId, value: durationMs(started, completed) });
    emitMetric('attempt_count', { jobId: job.jobId, jobItemId: item.jobItemId, value: item.attemptCount });
    return { processed: true, status: 'FAILED', job: finalJob };
  }
}

export async function handleGenerationQueue(batch, env) {
  for (const message of batch?.messages || []) await processJobItemMessage(message, env);
}
