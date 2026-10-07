import { canonical, identifier, failure, TERMINAL_SCENARIOS } from './contracts.js';
export function initialDocument() { return { prepared: false, applied: false, scenarios: [] }; }
const terminal = s => TERMINAL_SCENARIOS.includes(s.status);
const attention = (s, code) => Object.assign(s, { status: 'NEEDS_ATTENTION', reasonCode: code });
/** One bounded operation per wake. Same source scenarios are collected before
 * one grouped append. No closure/cookie/request/response body is persisted here. */
export function nextCommand(document) {
    if (!document.prepared)
        return { kind: 'PREPARE' };
    const s = document.scenarios.find(x => !terminal(x) && x.status !== 'PROPOSED');
    if (s) {
        const base = { scenarioId: s.scenarioId };
        if (['ANALYZE', 'ANALYZE_AFTER_RUN'].includes(s.status))
            return { kind: 'ANALYZE', ...base, afterRun: s.status === 'ANALYZE_AFTER_RUN', runId: s.sourceRunId || null };
        if (s.status === 'RUN')
            return { kind: 'RUN', ...base, attempt: s.sourceAttempt || 1, retryOfRunId: s.sourceRetryOfRunId || null };
        if (s.status === 'WAIT_RUN')
            return { kind: 'RUN_STATUS', ...base, runId: s.sourceRunId };
        if (s.status === 'VERIFY')
            return { kind: 'VERIFY', ...base, proposalId: s.proposalId, testDesignVersionId: s.appliedVersionId, retryOfRunId: s.verifyRetryOfRunId || null };
        if (s.status === 'WAIT_VERIFY')
            return { kind: 'VERIFY_STATUS', ...base, proposalId: s.proposalId, testDesignVersionId: s.appliedVersionId, runId: s.verificationRunId };
        if (s.status === 'RECONCILE')
            return { kind: 'RECONCILE', ...base, proposalId: s.proposalId, testDesignVersionId: s.appliedVersionId };
        failure('AUTONOMOUS_ITEM_STATE_INVALID');
    }
    const candidates = document.scenarios.filter(s => s.status === 'PROPOSED');
    if (candidates.length) {
        if (document.applied)
            failure('AUTONOMOUS_SECOND_APPEND_FORBIDDEN');
        return { kind: 'APPLY', proposalIds: candidates.map(s => s.proposalId).sort() };
    }
    return { kind: 'DONE' };
}
export function commandIdentity(document) { return canonical(nextCommand(document)); }
export function operationKind(command) { return ['RUN', 'VERIFY'].includes(command.kind) ? 'RUN' : command.kind === 'ANALYZE' ? 'ANALYSIS' : command.kind === 'APPLY' ? 'APPLICATION' : 'READ'; }
function requireOutcome(result) { if (!result || typeof result.status !== 'string')
    failure('AUTONOMOUS_STEP_RESPONSE_INVALID', 502); }
export function transition(document, command, result, policy) {
    requireOutcome(result);
    const d = structuredClone(document);
    if (result.status === 'WAIT')
        return { document: d, delaySeconds: Math.min(60, Math.max(5, result.delaySeconds || 10)), changed: false };
    if (command.kind === 'PREPARE') {
        if (result.status !== 'PREPARED' || !Array.isArray(result.scenarios) || result.scenarios.length > 50)
            failure('AUTONOMOUS_PREPARE_INVALID', 502);
        const seen = new Set();
        d.scenarios = result.scenarios.map(x => {
            identifier(x.scenarioId);
            if (seen.has(x.scenarioId) || !['ANALYZE', 'VERIFY', 'ALREADY_READY', 'PROTECTED', 'NEEDS_ATTENTION'].includes(x.status))
                failure('AUTONOMOUS_PREPARE_INVALID', 502);
            seen.add(x.scenarioId);
            const s = { scenarioId: x.scenarioId, status: x.status, reasonCode: x.reasonCode || null, sourceHash: x.sourceHash || null, sourceAttempt: 1, verificationRetries: 0 };
            if (x.status === 'VERIFY') {
                s.proposalId = identifier(x.proposalId);
                s.appliedVersionId = identifier(x.appliedVersionId);
            }
            return s;
        });
        d.prepared = true;
        return { document: d, delaySeconds: 0, changed: true };
    }
    if (command.kind === 'APPLY') {
        const targets = d.scenarios.filter(s => s.status === 'PROPOSED');
        if (result.status !== 'APPLIED' || !Array.isArray(result.proposals) || result.proposals.length !== targets.length) {
            for (const s of targets)
                attention(s, result.reasonCode || 'AUTONOMOUS_APPLICATION_NOT_COMPLETED');
            d.applied = true;
            return { document: d, delaySeconds: 0, changed: true };
        }
        const sourceIds = new Set(targets.map(s => s.proposalId));
        if (new Set(result.proposals.map(p => p.proposalId)).size !== targets.length || result.proposals.some(p => !sourceIds.has(p.proposalId) || p.status !== 'APPLIED' || p.testDesignVersionId !== result.testDesignVersionId))
            failure('AUTONOMOUS_APPLICATION_SCOPE_MISMATCH', 502);
        for (const s of targets) {
            s.appliedVersionId = identifier(result.testDesignVersionId);
            s.appliedVersion = result.testDesignVersion;
            s.status = 'VERIFY';
            s.decisionId = result.decisionId;
        }
        d.applied = true;
        return { document: d, delaySeconds: 0, changed: true };
    }
    const s = d.scenarios.find(x => x.scenarioId === command.scenarioId);
    if (!s)
        failure('AUTONOMOUS_SCENARIO_MISMATCH', 502);
    if (result.status === 'ERROR' || result.status === 'NEEDS_ATTENTION') {
        attention(s, result.reasonCode || 'AUTONOMOUS_STEP_REJECTED');
        return { document: d, delaySeconds: 0, changed: true };
    }
    if (command.kind === 'ANALYZE') {
        if (result.status === 'PROPOSED') {
            s.proposalId = identifier(result.proposalId);
            s.status = 'PROPOSED';
            s.reasonCode = null;
        }
        else if (result.status === 'APPLIED') {
            s.proposalId = identifier(result.proposalId);
            s.appliedVersionId = identifier(result.testDesignVersionId);
            s.status = 'VERIFY';
        }
        else if (result.status === 'ALREADY_READY') {
            s.status = 'ALREADY_READY';
        }
        else if (result.status === 'LEARNING_AVAILABLE' && !command.afterRun) {
            s.status = 'RUN';
        }
        else
            attention(s, result.reasonCode || 'AUTONOMOUS_NO_SUPPORTED_PROPOSAL');
    }
    else if (command.kind === 'RUN') {
        if (result.status !== 'CREATED' && result.status !== 'REUSED')
            failure('AUTONOMOUS_RUN_RESPONSE_INVALID', 502);
        s.sourceRunId = identifier(result.runId);
        s.status = 'WAIT_RUN';
    }
    else if (command.kind === 'RUN_STATUS') {
        if (result.status === 'PASSED') {
            s.status = 'ANALYZE_AFTER_RUN';
            s.sourceResultSetId = identifier(result.resultSetId);
        }
        else if (result.status === 'RETRYABLE_TIMEOUT' && s.sourceAttempt <= policy.limits.maxTechnicalRetries) {
            s.sourceRetryOfRunId = s.sourceRunId;
            s.sourceAttempt++;
            s.status = 'RUN';
            return { document: d, delaySeconds: Math.max(30, result.delaySeconds || 0), changed: true };
        }
        else
            attention(s, result.reasonCode || 'AUTONOMOUS_LEARNING_EXECUTION_FAILED');
    }
    else if (command.kind === 'VERIFY') {
        if (result.status === 'VERIFIED') {
            s.status = 'RECONCILE';
        }
        else if (['CREATED', 'REUSED'].includes(result.status)) {
            s.verificationRunId = identifier(result.runId);
            s.status = 'WAIT_VERIFY';
        }
        else
            attention(s, result.reasonCode || 'AUTONOMOUS_VERIFICATION_NOT_CREATED');
    }
    else if (command.kind === 'VERIFY_STATUS') {
        if (result.status === 'VERIFIED') {
            s.verificationId = identifier(result.verificationId);
            s.verificationResultSetId = identifier(result.resultSetId);
            s.status = 'RECONCILE';
        }
        else if (result.status === 'RETRYABLE_TIMEOUT' && s.verificationRetries < policy.limits.maxTechnicalRetries) {
            s.verifyRetryOfRunId = s.verificationRunId;
            s.verificationRetries++;
            s.status = 'VERIFY';
            return { document: d, delaySeconds: Math.max(30, result.delaySeconds || 0), changed: true };
        }
        else
            attention(s, result.reasonCode || 'AUTONOMOUS_VERIFICATION_FAILED');
    }
    else if (command.kind === 'RECONCILE') {
        if (result.status === 'VERIFIED') {
            s.status = 'VERIFIED';
            s.verificationId = identifier(result.verificationId);
            s.verificationResultSetId = identifier(result.resultSetId);
            s.reasonCode = null;
        }
        else
            attention(s, result.reasonCode || 'AUTONOMOUS_MATURITY_NOT_VERIFIED');
    }
    else
        failure('AUTONOMOUS_COMMAND_INVALID', 502);
    return { document: d, changed: true, delaySeconds: 0 };
}
