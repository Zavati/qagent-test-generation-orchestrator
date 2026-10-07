import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolicy, normalizeCycleStart, canonical, digest, assertExecutionAuthorization, assertOrigin } from '../src/autonomous/contracts.js';
import { initialDocument, nextCommand, transition } from '../src/autonomous/workflow.js';
const now = Date.now();
const policyInput = () => ({ contractVersion: 'qagent.autonomous-learning-policy.v1', enabled: true, expectedRevision: 0, confirmDelegation: true, confirmControlledEnvironment: true, profile: 'CONTROLLED_READS_V1', allowedOrigins: ['https://fixture.invalid'], allowedChangeTypes: ['SCENARIO_READINESS_CONFIRMATION', 'ASSERTION_COVERAGE_EXTENSION'], expiresAt: new Date(now + 86400000).toISOString(), limits: {} });
test('policy records a bounded explicit delegation, no automatic start', () => { const p = normalizePolicy(policyInput(), now); assert.equal(p.enabled, true); assert.equal(p.limits.concurrency, 2); assert.equal(p.limits.maxTechnicalRetries, 1); assert.ok(!('confirmStart' in p)); });
for (const [name, edit] of [
    ['missing delegation', p => delete p.confirmDelegation], ['uncontrolled environment', p => p.confirmControlledEnvironment = false], ['unknown capability', p => p.allowedChangeTypes = ['ARBITRARY_PATCH']], ['expired', p => p.expiresAt = new Date(now - 1000).toISOString()], ['unbounded duration', p => p.limits.maxDurationSeconds = 1e9], ['zero budget', p => p.limits.maxRuns = 0], ['excess concurrency', p => p.limits.concurrency = 5], ['extra authority', p => p.userId = 'usr_forge'], ['credentials in origin', p => p.allowedOrigins = ['https://user:pass@fixture.invalid']], ['origin path', p => p.allowedOrigins = ['https://fixture.invalid/resource']], ['non-http scheme', p => p.allowedOrigins = ['file:///tmp']], ['duplicate changes', p => p.allowedChangeTypes.push(p.allowedChangeTypes[0])]
])
    test('policy rejects ' + name, () => { const p = policyInput(); edit(p); assert.throws(() => normalizePolicy(p, now)); });
test('revocation accepts no implicit reactivation', () => assert.deepEqual(normalizePolicy({ contractVersion: 'qagent.autonomous-learning-policy.v1', enabled: false, expectedRevision: 1 }), { enabled: false, expectedRevision: 1 }));
test('start requires separate explicit consent and identity', () => { const v = { contractVersion: 'qagent.autonomous-learning-start.v1', environmentId: 'env_test', policyRevision: 1, requestId: 'request_test', confirmStart: true }; assert.equal(normalizeCycleStart(v).requestId, 'request_test'); assert.throws(() => normalizeCycleStart({ ...v, confirmStart: false })); assert.throws(() => normalizeCycleStart({ ...v, commands: [] })); });
test('canonical fingerprints ignore object key order but preserve array order', async () => { assert.equal(await digest({ b: 2, a: 1 }), await digest({ a: 1, b: 2 })); assert.notEqual(await digest([1, 2]), await digest([2, 1])); assert.throws(() => canonical({ value: undefined })); });
test('origin authorization matches exact origin, not a string prefix', () => { assert.equal(assertOrigin('https://fixture.invalid/a', ['https://fixture.invalid']), 'https://fixture.invalid'); assert.throws(() => assertOrigin('https://fixture.invalid.attacker.test', ['https://fixture.invalid'])); });
const policy = normalizePolicy(policyInput(), now);
const step = (d, r) => transition(d, nextCommand(d), r, policy).document;
test('endpoint groups two proposals into one append then verifies separately', () => {
    let d = step(initialDocument(), { status: 'PREPARED', scenarios: [{ scenarioId: 'first', status: 'ANALYZE' }, { scenarioId: 'second', status: 'ANALYZE' }, { scenarioId: 'blocked', status: 'NEEDS_ATTENTION', reasonCode: 'DATA_REQUIRED' }] });
    d = step(d, { status: 'LEARNING_AVAILABLE' });
    assert.equal(nextCommand(d).kind, 'RUN');
    d = step(d, { status: 'CREATED', runId: 'run_first' });
    d = step(d, { status: 'PASSED', resultSetId: 'rset_first' });
    d = step(d, { status: 'PROPOSED', proposalId: 'tep_first' });
    assert.equal(nextCommand(d).scenarioId, 'second');
    d = step(d, { status: 'PROPOSED', proposalId: 'tep_second' });
    assert.equal(nextCommand(d).kind, 'APPLY');
    assert.equal(nextCommand(d).proposalIds.length, 2);
    d = step(d, { status: 'APPLIED', testDesignVersionId: 'tdv_new', testDesignVersion: 2, decisionId: 'decision_test', proposals: ['tep_first', 'tep_second'].map(proposalId => ({ proposalId, status: 'APPLIED', testDesignVersionId: 'tdv_new' })) });
    for (const name of ['first', 'second']) {
        assert.equal(nextCommand(d).kind, 'VERIFY');
        d = step(d, { status: 'CREATED', runId: 'run_verify_' + name });
        d = step(d, { status: 'VERIFIED', verificationId: 'receipt_' + name, resultSetId: 'rset_' + name });
        d = step(d, { status: 'VERIFIED', verificationId: 'receipt_' + name, resultSetId: 'rset_' + name });
    }
    assert.equal(nextCommand(d).kind, 'DONE');
    assert.equal(d.scenarios.filter(s => s.status === 'VERIFIED').length, 2);
    assert.equal(d.scenarios[2].status, 'NEEDS_ATTENTION');
});
test('PASS on incomplete source never promotes without append and verification', () => { let d = step(initialDocument(), { status: 'PREPARED', scenarios: [{ scenarioId: 's', status: 'ANALYZE' }] }); d = step(d, { status: 'LEARNING_AVAILABLE' }); d = step(d, { status: 'CREATED', runId: 'run_source' }); d = step(d, { status: 'PASSED', resultSetId: 'rset_source' }); assert.equal(d.scenarios[0].status, 'ANALYZE_AFTER_RUN'); d = step(d, { status: 'NONE', reasonCode: 'NO_SUPPORTED_PROPOSAL' }); assert.equal(d.scenarios[0].status, 'NEEDS_ATTENTION'); });
test('already ready and baseline are not relearned', () => { const d = step(initialDocument(), { status: 'PREPARED', scenarios: [{ scenarioId: 'ready', status: 'ALREADY_READY' }, { scenarioId: 'base', status: 'PROTECTED' }] }); assert.equal(nextCommand(d).kind, 'DONE'); });
test('WAIT does not change state or manufacture successful evidence', () => { const d = initialDocument(), r = transition(d, nextCommand(d), { status: 'WAIT', delaySeconds: 1000 }, policy); assert.deepEqual(r.document, d); assert.equal(r.delaySeconds, 60); assert.equal(r.changed, false); });
test('technical source retries are bounded and preserve the predecessor', () => { let d = { prepared: true, applied: false, scenarios: [{ scenarioId: 's', status: 'WAIT_RUN', sourceRunId: 'run_timeout', sourceAttempt: 1 }] }; let x = transition(d, nextCommand(d), { status: 'RETRYABLE_TIMEOUT' }, policy); assert.equal(x.document.scenarios[0].sourceAttempt, 2); assert.equal(x.document.scenarios[0].sourceRetryOfRunId, 'run_timeout'); assert.equal(x.delaySeconds, 30); d = { ...x.document, scenarios: [{ ...x.document.scenarios[0], status: 'WAIT_RUN', sourceRunId: 'run_timeout_2' }] }; x = transition(d, nextCommand(d), { status: 'RETRYABLE_TIMEOUT' }, policy); assert.equal(x.document.scenarios[0].status, 'NEEDS_ATTENTION'); });
test('verification timeout uses bound retry, not manual adoption', () => { const d = { prepared: true, applied: true, scenarios: [{ scenarioId: 's', status: 'WAIT_VERIFY', proposalId: 'tep_s', appliedVersionId: 'tdv_new', verificationRunId: 'run_bound', verificationRetries: 0 }] }; const x = transition(d, nextCommand(d), { status: 'RETRYABLE_TIMEOUT' }, policy); assert.equal(nextCommand(x.document).retryOfRunId, 'run_bound'); assert.equal(nextCommand(x.document).kind, 'VERIFY'); });
test('group application rejects cross-version or duplicate member receipts', () => { const d = { prepared: true, applied: false, scenarios: [{ scenarioId: 's', status: 'PROPOSED', proposalId: 'tep_s' }] }; assert.throws(() => step(d, { status: 'APPLIED', testDesignVersionId: 'tdv_expected', testDesignVersion: 2, proposals: [{ proposalId: 'tep_s', status: 'APPLIED', testDesignVersionId: 'tdv_other' }] })); });
test('prepare rejects duplicate or unknown state', () => { for (const scenarios of [[{ scenarioId: 's', status: 'ANALYZE' }, { scenarioId: 's', status: 'ANALYZE' }], [{ scenarioId: 's', status: 'VERIFIED' }]])
    assert.throws(() => step(initialDocument(), { status: 'PREPARED', scenarios })); });
import { callLearningGateway } from '../src/autonomous/gatewayClient.js';
for (const mode of ['never-responds', 'stalled-stream'])
    test('Gateway callback deadline ' + mode, async () => { const env = { TEST_GENERATION_INTERNAL_HMAC_SECRET: 'synthetic-transport-test-secret-at-least-32', TEST_DESIGN_GENERATION_SERVICE: { fetch: mode === 'never-responds' ? () => new Promise(() => { }) : async () => new Response(new ReadableStream({ start() { } })) } }; await assert.rejects(callLearningGateway(env, { organizationId: 'org_test', projectId: 'prj_test' }, 'step', { cycleId: 'alc_test' }, { timeoutMs: 15 }), { code: 'AUTONOMOUS_GATEWAY_TIMEOUT' }); });
test('Gateway response is capped before buffering an arbitrary body', async () => { const env = { TEST_GENERATION_INTERNAL_HMAC_SECRET: 'synthetic-transport-test-secret-at-least-32', TEST_DESIGN_GENERATION_SERVICE: { fetch: async () => new Response('x'.repeat(1048577)) } }; await assert.rejects(callLearningGateway(env, { organizationId: 'org_test', projectId: 'prj_test' }, 'step', {}), { code: 'AUTONOMOUS_GATEWAY_RESPONSE_TOO_LARGE' }); });
