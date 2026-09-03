import { listAllProjectEndpoints } from '../clients/catalogClient.js';
import { getProjectTestInventory } from '../clients/testRegistryClient.js';
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_ITEM_ATTEMPTS, JOB_SCOPES } from '../contracts/jobContracts.js';
import { boundedInt } from '../lib/config.js';
import { OrchestratorError, safeErrorMessage } from '../lib/errors.js';
import { createJobId, createJobItemId, generationRequestIdForJobItem } from '../lib/ids.js';
import { emitMetric } from '../lib/metrics.js';
import { findActiveJob, insertJob, insertJobItems, markJobItemsQueued, markJobStructuralFailed } from '../persistence/jobRepository.js';
import { publishJobItems } from '../queue/publisher.js';
import { preflightProjectEndpoints } from './preflightProjectEndpoints.js';

export async function createProjectGenerationJob({
  env, organizationId, projectId, scope = 'MISSING_TEST_DESIGNS', createdBy = null, createdByAccountId = null,
  deps = {}, now = () => new Date().toISOString(),
}) {
  if (!JOB_SCOPES.has(scope)) throw new OrchestratorError('INVALID_PROJECT_SCOPE', 'Project Test Design Generation scope is invalid.', { status: 400, retryable: false });
  const active = await (deps.findActiveJob || findActiveJob)(env, { organizationId, projectId, scope });
  if (active) throw new OrchestratorError('PROJECT_TEST_DESIGN_GENERATION_ALREADY_RUNNING', 'A Project Test Design Generation job is already running for this project and scope.', { status: 409, retryable: false, details: { jobId: active.jobId } });

  const [endpoints, inventory] = await Promise.all([
    (deps.listEndpoints || listAllProjectEndpoints)({ env, organizationId, projectId }),
    (deps.getInventory || getProjectTestInventory)({ env, organizationId, projectId }),
  ]);
  const existingEndpointIds = new Set((inventory.items || []).map((item) => String(item?.endpointId || '')).filter(Boolean));
  const preflight = preflightProjectEndpoints({ endpoints, existingEndpointIds, scope });
  if (preflight.eligible.length === 0) {
    throw new OrchestratorError('NO_ELIGIBLE_ENDPOINTS', 'No endpoints are eligible for Project Test Design Generation.', {
      status: 409, retryable: false, details: { catalogEndpointCount: endpoints.length, existingTestDesignCount: existingEndpointIds.size, preflight: preflight.counts },
    });
  }

  const createdAt = now();
  const jobId = (deps.createJobId || createJobId)();
  const maxAttemptsPerEndpoint = boundedInt(env?.MAX_ITEM_ATTEMPTS, DEFAULT_MAX_ITEM_ATTEMPTS, 1, 10);
  const maxConcurrency = boundedInt(env?.MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, 1, 20);
  const items = preflight.eligible.map((endpoint) => {
    const jobItemId = (deps.createJobItemId || createJobItemId)();
    return {
      jobItemId, jobId, organizationId, projectId, endpointId: String(endpoint.endpointId),
      method: String(endpoint.method || '').toUpperCase() || null,
      path: String(endpoint.normalizedPath || endpoint.path || '') || null,
      maxAttempts: maxAttemptsPerEndpoint, generationRequestId: generationRequestIdForJobItem(jobItemId), createdAt,
    };
  });
  const preflightSummary = {
    counts: preflight.counts,
    excludedCount: preflight.excluded.length,
    snapshotCreatedAt: createdAt,
  };
  const job = {
    jobId, organizationId, projectId, scope, status: 'QUEUED', endpointCount: items.length,
    catalogEndpointCount: endpoints.length, existingTestDesignCount: existingEndpointIds.size,
    eligibleCount: items.length, ineligibleCount: preflight.excluded.filter((x) => x.classification !== 'ALREADY_HAS_TEST_DESIGN').length,
    preflight: preflightSummary, maxAttemptsPerEndpoint, maxConcurrency, createdBy, createdByAccountId, createdAt,
  };

  await (deps.insertJob || insertJob)(env, job);
  try {
    await (deps.insertItems || insertJobItems)(env, items);
    await (deps.publishItems || publishJobItems)(env, items);
    const persisted = await (deps.markQueued || markJobItemsQueued)(env, { jobId, now: now() });
    console.log('project_test_design_generation_job_created', { jobId, organizationId, projectId, scope, endpointCount: items.length, maxAttemptsPerEndpoint, maxConcurrency });
    emitMetric('jobs_created', { jobId, organizationId, projectId, scope });
    emitMetric('items_queued', { jobId, organizationId, projectId, value: items.length });
    return persisted;
  } catch (error) {
    await (deps.markStructuralFailed || markJobStructuralFailed)(env, { organizationId, jobId, code: error?.code || 'JOB_PERSISTENCE_FAILED', message: safeErrorMessage(error), now: now() });
    throw error;
  }
}
