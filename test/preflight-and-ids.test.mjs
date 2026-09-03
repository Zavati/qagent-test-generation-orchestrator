import test from 'node:test';
import assert from 'node:assert/strict';
import { generationRequestIdForJobItem } from '../src/lib/ids.js';
import { preflightProjectEndpoints } from '../src/jobs/preflightProjectEndpoints.js';
import { retryDelaySeconds } from '../src/retry/backoff.js';
import { classifyRetry } from '../src/retry/classifyRetry.js';
import { deriveJobStatus } from '../src/jobs/progress.js';

test('MISSING_TEST_DESIGNS excludes existing designs and unsupported endpoints', () => {
  const endpoints = [
    { endpointId: 'A', method: 'GET', normalizedPath: '/a', lifecycleState: 'DISCOVERED', classification: 'API' },
    { endpointId: 'B', method: 'POST', normalizedPath: '/b', lifecycleState: 'DISCOVERED', classification: 'API' },
    { endpointId: 'C', method: 'GET', normalizedPath: '/c', lifecycleState: 'DISCOVERED', classification: 'API' },
    { endpointId: 'D', method: 'GET', normalizedPath: '/asset', lifecycleState: 'DISCOVERED', classification: 'STATIC_ASSET' },
  ];
  const result = preflightProjectEndpoints({ endpoints, existingEndpointIds: new Set(['C']), scope: 'MISSING_TEST_DESIGNS' });
  assert.deepEqual(result.eligible.map((x) => x.endpointId), ['A', 'B']);
  assert.equal(result.counts.ALREADY_HAS_TEST_DESIGN, 1);
  assert.equal(result.counts.UNSUPPORTED, 1);
});

test('ALL_ENDPOINTS includes endpoints that already have Test Designs', () => {
  const endpoints = [{ endpointId: 'C', method: 'GET', normalizedPath: '/c', lifecycleState: 'DISCOVERED', classification: 'API' }];
  const result = preflightProjectEndpoints({ endpoints, existingEndpointIds: new Set(['C']), scope: 'ALL_ENDPOINTS' });
  assert.equal(result.eligible.length, 1);
});

test('job item maps deterministically to Registry-compatible generation request id', () => {
  assert.equal(generationRequestIdForJobItem('tdjobi_12345678'), 'tdg_tdjobi_12345678');
});

test('retry policy follows bounded backoff and permanent errors do not retry', () => {
  assert.deepEqual([1,2,3,4,5].map(retryDelaySeconds), [30,60,120,300,300]);
  assert.equal(classifyRetry({ code: 'AI_PROVIDER_TIMEOUT' }).retryable, true);
  assert.equal(classifyRetry({ code: 'INSUFFICIENT_CONTEXT', retryable: true }).retryable, false);
});

test('safe error messages redact credential-shaped material', async () => {
  const { safeErrorMessage } = await import('../src/lib/errors.js');
  const safe = safeErrorMessage(new Error('Authorization: Bearer abc123 password=hunter2 x-api-key: supersecret? token=tok_123'));
  assert.doesNotMatch(safe, /abc123|hunter2|supersecret|tok_123/);
  assert.match(safe, /\[REDACTED\]/);
});


test('job lifecycle distinguishes full success, partial success and structural failure', () => {
  assert.equal(deriveJobStatus({ currentStatus:'RUNNING', total:10, running:0, succeeded:10, failed:0 }), 'COMPLETED');
  assert.equal(deriveJobStatus({ currentStatus:'RUNNING', total:10, running:0, succeeded:9, failed:1 }), 'COMPLETED_WITH_FAILURES');
  assert.equal(deriveJobStatus({ currentStatus:'FAILED', total:10, running:0, succeeded:9, failed:1 }), 'FAILED');
  assert.equal(deriveJobStatus({ currentStatus:'QUEUED', total:10, running:1, succeeded:0, failed:0 }), 'RUNNING');
});
