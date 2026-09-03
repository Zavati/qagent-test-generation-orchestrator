import test from 'node:test';
import assert from 'node:assert/strict';
import { processJobItemMessage } from '../src/queue/consumer.js';

function message(body) {
  return { body, acked: false, retried: null, ack(){ this.acked = true; }, retry(options){ this.retried = options; } };
}
const body = { contractVersion: 'qagent.project-test-design-generation-job-item.v1', jobId: 'tdjob_1', jobItemId: 'tdjobi_12345678', organizationId: 'org_1', projectId: 'prj_1', endpointId: 'A', attemptNumber: 1 };
const job = { jobId:'tdjob_1', organizationId:'org_1', projectId:'prj_1', status:'RUNNING', createdByAccountId:'acct_1' };
const current = { jobItemId:'tdjobi_12345678', jobId:'tdjob_1', endpointId:'A', status:'QUEUED', attemptCount:0, maxAttempts:5, generationRequestId:'tdg_tdjobi_12345678' };

test('success persists result and acknowledges queue message', async () => {
  const m = message(body); let successArgs = null;
  const result = await processJobItemMessage(m, {}, { now: () => '2026-09-03T13:00:00.000Z', deps: {
    getJob: async () => job, getItem: async () => current,
    claimItem: async () => ({ ...current, status:'GENERATING', attemptCount:1 }), refresh: async () => ({ ...job, status:'RUNNING' }),
    generate: async (args) => { assert.equal(args.generationRequestId, current.generationRequestId); return { testDesignId:'td_1', testDesignVersionId:'tdv_1', testDesignVersion:1 }; },
    markSucceeded: async (_env, args) => { successArgs = args; },
  }});
  assert.equal(result.status, 'SUCCEEDED'); assert.equal(m.acked, true); assert.equal(successArgs.testDesignVersion, 1);
});

test('retryable failure enters RETRY_WAIT with first 30s backoff', async () => {
  const m = message(body); let retryArgs = null;
  const result = await processJobItemMessage(m, {}, { now: () => '2026-09-03T13:00:00.000Z', deps: {
    getJob: async () => job, getItem: async () => current,
    claimItem: async () => ({ ...current, status:'GENERATING', attemptCount:1 }), refresh: async () => job,
    generate: async () => { const e = new Error('timeout'); e.code='AI_PROVIDER_TIMEOUT'; e.retryable=true; throw e; },
    markRetryWait: async (_env, args) => { retryArgs = args; },
  }});
  assert.equal(result.status, 'RETRY_WAIT'); assert.deepEqual(m.retried, { delaySeconds:30 }); assert.equal(retryArgs.nextRetryAt, '2026-09-03T13:00:30.000Z');
});

test('terminal item makes Queue redelivery idempotent', async () => {
  const m = message(body); let generated = 0;
  const result = await processJobItemMessage(m, {}, { deps: { getJob: async () => job, getItem: async () => ({ ...current, status:'SUCCEEDED' }), generate: async () => { generated += 1; } } });
  assert.equal(result.reason, 'ITEM_TERMINAL'); assert.equal(m.acked, true); assert.equal(generated, 0);
});

test('stale GENERATING claim is recovered and the same logical item resumes safely', async () => {
  const m = message(body); let recovered = false; let claims = 0;
  const stale = { ...current, status:'GENERATING', attemptCount:1, lastAttemptAt:'2026-09-03T12:55:00.000Z', startedAt:'2026-09-03T12:55:00.000Z' };
  const result = await processJobItemMessage(m, { ITEM_CLAIM_LEASE_SECONDS:'180' }, { now: () => '2026-09-03T13:00:00.000Z', deps: {
    getJob: async () => job, getItem: async () => stale,
    recoverStale: async () => { recovered = true; return true; },
    claimItem: async () => { claims += 1; return { ...stale, status:'GENERATING', attemptCount:2 }; },
    refresh: async () => job,
    generate: async (args) => { assert.equal(args.generationRequestId, stale.generationRequestId); return { testDesignId:'td_same', testDesignVersionId:'tdv_same', testDesignVersion:3 }; },
    markSucceeded: async () => {},
  }});
  assert.equal(recovered, true); assert.equal(claims, 1); assert.equal(result.status, 'SUCCEEDED'); assert.equal(m.acked, true);
});
