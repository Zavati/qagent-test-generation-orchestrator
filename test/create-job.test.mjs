import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectGenerationJob } from '../src/jobs/createProjectGenerationJob.js';

test('creates immutable eligible snapshot and queues one item per endpoint', async () => {
  const state = { insertedJob: null, insertedItems: null, published: null, queued: null };
  let itemCounter = 0;
  const result = await createProjectGenerationJob({
    env: { MAX_ITEM_ATTEMPTS: '5', MAX_CONCURRENCY: '3' }, organizationId: 'org_1', projectId: 'prj_1', scope: 'MISSING_TEST_DESIGNS', createdBy: 'usr_1', createdByAccountId: 'acct_1',
    now: () => '2026-09-03T13:00:00.000Z',
    deps: {
      findActiveJob: async () => null,
      listEndpoints: async () => [
        { endpointId: 'A', method: 'GET', normalizedPath: '/a', classification: 'API', lifecycleState: 'DISCOVERED' },
        { endpointId: 'B', method: 'POST', normalizedPath: '/b', classification: 'API', lifecycleState: 'DISCOVERED' },
        { endpointId: 'C', method: 'GET', normalizedPath: '/c', classification: 'API', lifecycleState: 'DISCOVERED' },
      ],
      getInventory: async () => ({ items: [{ endpointId: 'C' }] }),
      createJobId: () => 'tdjob_fixed123',
      createJobItemId: () => `tdjobi_fixed000${++itemCounter}`,
      insertJob: async (_env, job) => { state.insertedJob = job; },
      insertItems: async (_env, items) => { state.insertedItems = items; },
      publishItems: async (_env, items) => { state.published = items; },
      markQueued: async (_env, { jobId }) => { state.queued = jobId; return { ...state.insertedJob, pendingCount: 0, queuedCount: 2 }; },
      markStructuralFailed: async () => { throw new Error('should not fail'); },
    },
  });
  assert.equal(result.endpointCount, 2);
  assert.deepEqual(state.insertedItems.map((x) => x.endpointId), ['A','B']);
  assert.equal(state.published.length, 2);
  assert.equal(state.insertedItems[0].generationRequestId, `tdg_${state.insertedItems[0].jobItemId}`);
  assert.equal(state.queued, 'tdjob_fixed123');
});

test('duplicate active project/scope is rejected with existing job id', async () => {
  await assert.rejects(() => createProjectGenerationJob({
    env: {}, organizationId: 'org_1', projectId: 'prj_1', scope: 'MISSING_TEST_DESIGNS',
    deps: { findActiveJob: async () => ({ jobId: 'tdjob_existing' }) },
  }), (error) => error.code === 'PROJECT_TEST_DESIGN_GENERATION_ALREADY_RUNNING' && error.details.jobId === 'tdjob_existing');
});
