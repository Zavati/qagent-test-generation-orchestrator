import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findActiveJob } from '../src/persistence/jobRepository.js';
import { generateEndpointTestDesign } from '../src/clients/gatewayGenerationClient.js';
import { verifyInternalRequest } from '../src/security/internalAuth.js';
import { preflightProjectEndpoints } from '../src/jobs/preflightProjectEndpoints.js';
import { classifyRetry } from '../src/retry/classifyRetry.js';
const secret = 'synthetic-compatibility-test-secret-not-production-123456789';
const scope = { organizationId: 'org_test', projectId: 'prj_test' };
const input = { ...scope, endpointId: 'cep_test', accountId: 'cus_test', jobId: 'tdjob_test1234', jobItemId: 'tdjobi_test1234', generationRequestId: 'tdg_tdjobi_test1234' };
const env = { TEST_GENERATION_INTERNAL_HMAC_SECRET: secret };

test('D1 binding in deployment config actually resolves through the job repository', async () => {
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].binding, 'TEST_GENERATION_DB');
  let prepared = false;
  const db = { prepare(sql) { prepared = true; assert.match(sql, /test_design_generation_jobs/); return { bind() { return { first: async () => null }; } }; } };
  const runtime = { [config.d1_databases[0].binding]: db };
  assert.equal(await findActiveJob(runtime, { ...scope, scope: 'ALL_ENDPOINTS' }), null);
  assert.equal(prepared, true);
});

test('delegates generation to Gateway with valid HMAC and stable request id, no implicit baseline consent', async () => {
  const result = { testDesignId: 'td_test', testDesignVersionId: 'tdv_test', testDesignVersion: 2, persisted: true };
  const response = await generateEndpointTestDesign({ env, ...input, fetchImpl: async request => {
    const rawBody = await request.clone().text();
    assert.deepEqual(await verifyInternalRequest(request, env, { rawBody }), scope);
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).pathname, `/internal/v1/test-design-generation/endpoints/${input.endpointId}/generate`);
    const payload = JSON.parse(rawBody);
    assert.equal(payload.generationRequestId, input.generationRequestId);
    assert.equal(payload.initiator.type, 'PROJECT_GENERATION_JOB');
    assert.equal('baselineOptions' in payload, false);
    assert.equal('baselineActorId' in payload, false);
    return Response.json({ status: 'ok', data: result });
  } });
  assert.deepEqual(response, result);
});

test('baseline-preservation HTTP 409 terminates instead of retrying or weakening expectations', async () => {
  await assert.rejects(() => generateEndpointTestDesign({ env, ...input, fetchImpl: async () => Response.json({
    status: 'error', code: 'OBSERVED_BASELINE_PRESERVATION_REQUIRED', message: 'Protected baseline cannot be discarded.'
  }, { status: 409 }) }), error => {
    assert.equal(error.code, 'OBSERVED_BASELINE_PRESERVATION_REQUIRED');
    assert.equal(classifyRetry(error).retryable, false);
    return true;
  });
});

test('temporary Gateway/Catalog unavailability still retries', async () => {
  await assert.rejects(() => generateEndpointTestDesign({ env, ...input, fetchImpl: async () => Response.json({
    status: 'error', code: 'CATALOG_KNOWLEDGE_UPSTREAM_UNAVAILABLE', message: 'Source unavailable temporarily.'
  }, { status: 503 }) }), error => {
    assert.equal(classifyRetry(error).retryable, true);
    return true;
  });
});

test('MISSING_TEST_DESIGNS does not retroactively treat legacy Test Designs as absent', () => {
  const endpoints = [{ endpointId: 'cep_old', method: 'GET', normalizedPath: '/items', lifecycleState: 'DISCOVERED', classification: 'API' }];
  const result = preflightProjectEndpoints({ endpoints, existingEndpointIds: new Set(['cep_old']), scope: 'MISSING_TEST_DESIGNS' });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.excluded[0].classification, 'ALREADY_HAS_TEST_DESIGN');
});

test('ALL_ENDPOINTS allows the shared Gateway to generate a new immutable version of existing designs', () => {
  const endpoints = [{ endpointId: 'cep_old', method: 'GET', normalizedPath: '/items', lifecycleState: 'DISCOVERED', classification: 'API' }];
  const result = preflightProjectEndpoints({ endpoints, existingEndpointIds: new Set(['cep_old']), scope: 'ALL_ENDPOINTS' });
  assert.equal(result.eligible.length, 1);
});
