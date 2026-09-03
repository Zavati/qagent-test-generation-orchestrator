import { CREATE_CONTRACT_VERSION, JOB_SCOPES } from '../contracts/jobContracts.js';
import { createProjectGenerationJob } from '../jobs/createProjectGenerationJob.js';
import { toJobRead } from '../jobs/progress.js';
import { OrchestratorError } from '../lib/errors.js';
import { getJob, listJobItems, listJobs } from '../persistence/jobRepository.js';
import { verifyInternalRequest } from '../security/internalAuth.js';

function requireProjectScope(auth, projectId) {
  if (!auth.projectId || auth.projectId !== projectId) throw new OrchestratorError('JOB_NOT_ACCESSIBLE', 'Project generation job is not accessible.', { status: 403, retryable: false });
}
export async function createJobRoute(request, env, { projectId }) {
  const rawBody = await request.text();
  const auth = await verifyInternalRequest(request, env, { rawBody });
  requireProjectScope(auth, projectId);
  let input; try { input = rawBody ? JSON.parse(rawBody) : {}; } catch { throw new OrchestratorError('INVALID_JSON', 'Request body must be valid JSON.', { status: 400 }); }
  const scope = String(input?.scope || 'MISSING_TEST_DESIGNS').trim().toUpperCase();
  if (!JOB_SCOPES.has(scope)) throw new OrchestratorError('INVALID_PROJECT_SCOPE', 'Project Test Design Generation scope is invalid.', { status: 400 });
  const job = await createProjectGenerationJob({ env, organizationId: auth.organizationId, projectId, scope, createdBy: input?.createdBy || null, createdByAccountId: input?.createdByAccountId || null });
  return { status: 202, body: { status: 'ok', data: { ...toJobRead(job), createContractVersion: CREATE_CONTRACT_VERSION } } };
}
export async function getJobRoute(request, env, { jobId }) {
  const auth = await verifyInternalRequest(request, env);
  const job = await getJob(env, { organizationId: auth.organizationId, jobId });
  if (!job) throw new OrchestratorError('JOB_NOT_FOUND', 'Project Test Design Generation job was not found.', { status: 404 });
  if (auth.projectId && auth.projectId !== job.projectId) throw new OrchestratorError('JOB_NOT_ACCESSIBLE', 'Project generation job is not accessible.', { status: 403 });
  return { status: 200, body: { status: 'ok', data: toJobRead(job) } };
}
export async function listJobItemsRoute(request, env, { jobId }) {
  const auth = await verifyInternalRequest(request, env);
  const result = await listJobItems(env, { organizationId: auth.organizationId, jobId });
  if (!result.job) throw new OrchestratorError('JOB_NOT_FOUND', 'Project Test Design Generation job was not found.', { status: 404 });
  if (auth.projectId && auth.projectId !== result.job.projectId) throw new OrchestratorError('JOB_NOT_ACCESSIBLE', 'Project generation job is not accessible.', { status: 403 });
  return { status: 200, body: { status: 'ok', data: { job: toJobRead(result.job), items: result.items, itemCount: result.items.length } } };
}
export async function listJobsRoute(request, env, { projectId }) {
  const auth = await verifyInternalRequest(request, env);
  requireProjectScope(auth, projectId);
  const url = new URL(request.url);
  const jobs = await listJobs(env, { organizationId: auth.organizationId, projectId, limit: url.searchParams.get('limit') || 20 });
  return { status: 200, body: { status: 'ok', data: { projectId, jobs: jobs.map(toJobRead), count: jobs.length } } };
}
