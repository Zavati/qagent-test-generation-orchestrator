import { autonomousRoute } from './autonomous/routes.js';
import { handleAutonomousQueue } from './autonomous/queue.js';
import { recoverLearning } from './autonomous/service.js';
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_ITEM_ATTEMPTS, FOUNDATION_REVISION } from './contracts/jobContracts.js';
import { boundedInt } from './lib/config.js';
import { asOrchestratorError } from './lib/errors.js';
import { json } from './lib/json.js';
import { createJobRoute, getJobRoute, listJobItemsRoute, listJobsRoute } from './routes/jobs.js';
import { uiRoute } from './ui/routes.js';
import { processUiMessage, recoverUiJobs } from './ui/service.js';
import { UI_WAKE_VERSION } from './ui/contracts.js';
import { processJobItemMessage } from './queue/consumer.js';

const SERVICE = 'qagent-test-generation-orchestrator';
function notFound() { return json({ status: 'error', code: 'PROJECT_TEST_DESIGN_GENERATION_ROUTE_NOT_FOUND', message: 'Route not found.' }, { status: 404 }); }
function methodNotAllowed(allowed) { return json({ status: 'error', code: 'PROJECT_TEST_DESIGN_GENERATION_METHOD_NOT_ALLOWED', message: 'Method not allowed.' }, { status: 405, headers: { allow: allowed.join(', ') } }); }
function errorResponse(error) {
  if(/^AUTONOMOUS_[A-Z0-9_]+$/.test(error?.code||''))return json({status:'error',code:error.code,message:'Operação autônoma indisponível ou inválida.',retryable:error.retryable===true},{status:error.status||409});
  const safe = asOrchestratorError(error);
  const body = { status: 'error', code: safe.code, message: safe.message, retryable: safe.retryable === true };
  if (safe.details) body.details = safe.details;
  return json(body, { status: safe.status });
}
function match(pathname, regex) { const value = pathname.match(regex); return value ? value.slice(1).map(decodeURIComponent) : null; }
export function buildHealthPayload(env = {}) {
  return {
    status: 'ok', service: SERVICE, revision: FOUNDATION_REVISION,
    maxConcurrency: boundedInt(env?.MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, 1, 20),
    maxAttemptsPerEndpoint: boundedInt(env?.MAX_ITEM_ATTEMPTS, DEFAULT_MAX_ITEM_ATTEMPTS, 1, 10),
    queueEnabled: Boolean(env?.TEST_DESIGN_GENERATION_QUEUE),
  };
}
export async function handleRequest(request, env = {}) {
  const url = new URL(request.url);
  try {
    const ui=await uiRoute(request,env);if(ui)return json(ui.body,{status:ui.status});
    const autonomous=await autonomousRoute(request,env);if(autonomous)return json(autonomous.body,{status:autonomous.status});
    if (url.pathname === '/health' || url.pathname === '/v1/test-design-generation/health') {
      if (request.method !== 'GET') return methodNotAllowed(['GET']);
      return json(buildHealthPayload(env));
    }
    let values = match(url.pathname, /^\/v1\/test-design-generation\/projects\/([^/]+)\/jobs$/);
    if (values) {
      const [projectId] = values;
      if (request.method === 'POST') { const result = await createJobRoute(request, env, { projectId }); return json(result.body, { status: result.status }); }
      if (request.method === 'GET') { const result = await listJobsRoute(request, env, { projectId }); return json(result.body, { status: result.status }); }
      return methodNotAllowed(['GET', 'POST']);
    }
    values = match(url.pathname, /^\/v1\/test-design-generation\/jobs\/([^/]+)\/items$/);
    if (values) {
      if (request.method !== 'GET') return methodNotAllowed(['GET']);
      const result = await listJobItemsRoute(request, env, { jobId: values[0] }); return json(result.body, { status: result.status });
    }
    values = match(url.pathname, /^\/v1\/test-design-generation\/jobs\/([^/]+)$/);
    if (values) {
      if (request.method !== 'GET') return methodNotAllowed(['GET']);
      const result = await getJobRoute(request, env, { jobId: values[0] }); return json(result.body, { status: result.status });
    }
    return notFound();
  } catch (error) { return errorResponse(error); }
}
export default {
  async fetch(request, env) { return handleRequest(request, env); },
  async scheduled(controller,env,ctx) { ctx.waitUntil(Promise.allSettled([recoverLearning(env),recoverUiJobs(env)])); },
  async queue(batch, env) {
    if(String(batch?.queue||'')==='qagent-autonomous-learning')return handleAutonomousQueue(batch,env);
    if (String(batch?.queue || '') !== 'qagent-test-design-generation') return;
    // One existing queue, explicit domain dispatch. UI never enters the API/AI use case.
    for (const message of batch?.messages || []) {
      if(message?.body?.contractVersion===UI_WAKE_VERSION) await processUiMessage(message,env);
      else await processJobItemMessage(message,env);
    }
  },
};
