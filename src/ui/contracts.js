import { OrchestratorError } from '../lib/errors.js';
import { sha256TextHex } from '../security/internalAuth.js';

export const UI_JOB_VERSION = 'qagent.ui-test-design-generation-job.v1';
export const UI_WAKE_VERSION = 'qagent.ui-test-design-generation-wake.v1';
export const UI_COMPILATION_VERSION = 'qagent.ui-test-design-compilation.v1';
export const UI_COMPILER_VERSION = 'qagent_ui_test_design_compiler_v1';
export const MAX_UI_SOURCES = 50;
export const MAX_CANDIDATE_BYTES = 768 * 1024;
export const DEFAULT_UI_PROFILE = Object.freeze({
  contractVersion: 'qagent.ui-test-design-profile.v1', revision: 1,
  comparisonPolicyVersion: 'qagent_ui_observed_comparison_v1', layoutTolerancePx: 2,
  maxChecks: 2000, maxNodes: 25000, maxArtifactBytes: 33554432,
});
export const TERMINAL_UI_ITEMS = new Set(['SUCCEEDED','NO_DESIGN','FAILED','CANCELLED']);
export const TERMINAL_UI_JOBS = new Set(['COMPLETED','COMPLETED_WITH_FAILURES','FAILED','CANCELLED']);
export function uiError(code, status = 400, retryable = false) {
  return new OrchestratorError(code, 'UI Test Design operation could not be completed.', { status, retryable });
}
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw uiError('UI_JOB_JSON_INVALID');
}
export const hash = value => sha256TextHex(canonical(value));
export function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value); }
export function scopeOf(value) {
  const scope = { organizationId: value?.organizationId, projectId: value?.projectId, environmentId: value?.environmentId };
  if (!Object.values(scope).every(validId)) throw uiError('UI_JOB_SCOPE_INVALID');
  return scope;
}
export function sameScope(a, b) { return ['organizationId','projectId','environmentId'].every(key => a?.[key] === b?.[key]); }
function plain(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
export function normalizeProfile(value) {
  if (value === undefined || (plain(value) && Object.keys(value).length === 0)) return { ...DEFAULT_UI_PROFILE };
  if (!plain(value) || Object.keys(value).sort().join(',') !== Object.keys(DEFAULT_UI_PROFILE).sort().join(',')) throw uiError('UI_TEST_DESIGN_PROFILE_INVALID');
  if (value.contractVersion !== DEFAULT_UI_PROFILE.contractVersion || value.revision !== 1 || value.comparisonPolicyVersion !== DEFAULT_UI_PROFILE.comparisonPolicyVersion) throw uiError('UI_TEST_DESIGN_PROFILE_UNSUPPORTED');
  if (!Number.isFinite(value.layoutTolerancePx) || value.layoutTolerancePx < 0 || value.layoutTolerancePx > 20) throw uiError('UI_TEST_DESIGN_PROFILE_INVALID');
  for (const [key,min,max] of [['maxChecks',1,5000],['maxNodes',1,50000],['maxArtifactBytes',1024,67108864]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) throw uiError('UI_TEST_DESIGN_PROFILE_INVALID');
  }
  return JSON.parse(canonical(value));
}
export async function normalizeUiJob(input, scope) {
  if (!plain(input) || Object.keys(input).some(key => !['organizationId','projectId','environmentId','operationId','bundleVersionIds','compilerVersion','profile','createdBy','createdByAccountId'].includes(key))) throw uiError('UI_JOB_INPUT_INVALID');
  if (!sameScope({ ...input, projectId: input.projectId ?? scope.projectId }, scope)) throw uiError('UI_JOB_SCOPE_MISMATCH',403);
  if (!validId(input.operationId)) throw uiError('UI_JOB_OPERATION_ID_INVALID');
  if (input.compilerVersion !== UI_COMPILER_VERSION) throw uiError('UI_TEST_DESIGN_COMPILER_UNSUPPORTED');
  if (!Array.isArray(input.bundleVersionIds) || input.bundleVersionIds.length < 1 || input.bundleVersionIds.length > MAX_UI_SOURCES || !input.bundleVersionIds.every(id => validId(id) && id.startsWith('urbv_'))) throw uiError('UI_JOB_SOURCES_INVALID');
  for (const key of ['createdBy','createdByAccountId']) if (input[key] != null && !validId(input[key])) throw uiError('UI_JOB_ACTOR_INVALID');
  const bundleVersionIds = [...new Set(input.bundleVersionIds)].sort();
  const profile = normalizeProfile(input.profile);
  const definition = { ...scope, compilerVersion: UI_COMPILER_VERSION, profile, bundleVersionIds };
  return { ...definition, operationId: input.operationId, requestHash: await hash(definition), createdBy: input.createdBy ?? null, createdByAccountId: input.createdByAccountId ?? null };
}
export async function validateCompilation(value, job, item) {
  if (!plain(value) || value.contractVersion !== UI_COMPILATION_VERSION || value.compilerVersion !== job.compilerVersion || value.executionPerformed !== false || !['COMPILED','NO_DESIGN'].includes(value.outcome)) throw uiError('UI_COMPILATION_INVALID',502,false);
  const source = value.source;
  if (!plain(source) || !sameScope(source.scope,job) || source.bundleVersionId !== item.bundleVersionId || !validId(source.captureId) || ![source.sourceHash,source.manifestHash].every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s))) throw uiError('UI_COMPILATION_SOURCE_MISMATCH',502,false);
  if (!plain(value.summary) || !Array.isArray(value.summary.reasonCodes) || !Array.isArray(value.summary.limitations)) throw uiError('UI_COMPILATION_INVALID',502,false);
  if (value.outcome === 'NO_DESIGN') {
    if (value.specification !== null || value.specificationHash !== null || value.summary.reasonCodes.length === 0) throw uiError('UI_COMPILATION_INVALID',502,false);
  } else {
    const spec = value.specification;
    if (!plain(spec) || spec.contractVersion !== 'qagent.ui-test-design.v1' || spec.compilerVersion !== job.compilerVersion || spec.executionPerformed !== false || canonical(spec.source) !== canonical(source) || !sameScope(spec.scope,job) || canonical(spec.profile) !== canonical(job.profile) || canonical(spec.executionModes) !== '["UI_REPLAY","UI_LIVE"]') throw uiError('UI_COMPILATION_INVALID',502,false);
    if (value.specificationHash !== await hash(spec)) throw uiError('UI_COMPILATION_HASH_MISMATCH',502,false);
  }
  const candidateJson = canonical(value);
  if (new TextEncoder().encode(candidateJson).byteLength > MAX_CANDIDATE_BYTES) throw uiError('UI_COMPILATION_BUDGET_EXCEEDED',422,false);
  return { compilation: value, candidateJson, candidateHash: await sha256TextHex(candidateJson), specificationHash: value.specificationHash };
}
export function validatePublication(result, candidate) {
  if (!plain(result) || !['persisted','reused'].includes(result.status) || result.domain !== 'UI' || !validId(result.testDesignId) || !validId(result.testDesignVersionId) || !Number.isSafeInteger(result.version) || result.version < 1 || result.contentHash !== candidate.specificationHash) throw uiError('UI_PUBLICATION_RESPONSE_INVALID',502,true);
  return result;
}
export function wakeFor(item) {
  return { contractVersion: UI_WAKE_VERSION, jobId: item.jobId, jobItemId: item.jobItemId, organizationId: item.organizationId, projectId: item.projectId, environmentId: item.environmentId };
}
export function validWake(body) { return body?.contractVersion === UI_WAKE_VERSION && ['jobId','jobItemId','organizationId','projectId','environmentId'].every(key => validId(body[key])); }
