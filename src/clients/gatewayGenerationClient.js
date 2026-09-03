import { buildInternalHeaders } from '../security/internalAuth.js';
import { OrchestratorError } from '../lib/errors.js';

// Gateway enforces api.apiqagent.com as Host in production; Service Binding still routes internally.
const INTERNAL_BASE = 'https://api.apiqagent.com';
export async function generateEndpointTestDesign({ env, organizationId, projectId, endpointId, accountId, jobId, jobItemId, generationRequestId, fetchImpl = null }) {
  const binding = env?.TEST_DESIGN_GENERATION_SERVICE;
  if (!fetchImpl && (!binding || typeof binding.fetch !== 'function')) throw new OrchestratorError('TEST_DESIGN_GENERATION_NOT_CONFIGURED', 'Gateway generation service binding is not configured.', { status: 503, retryable: true });
  const url = `${INTERNAL_BASE}/internal/v1/test-design-generation/endpoints/${encodeURIComponent(endpointId)}/generate`;
  const payload = {
    organizationId, projectId, endpointId, accountId: accountId || null, generationRequestId,
    initiator: { type: 'PROJECT_GENERATION_JOB', jobId, jobItemId },
  };
  const rawBody = JSON.stringify(payload);
  const headers = await buildInternalHeaders({ env, method: 'POST', url, organizationId, projectId, rawBody });
  const request = new Request(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' }, body: rawBody });
  let response;
  try { response = fetchImpl ? await fetchImpl(request) : await binding.fetch(request); }
  catch (error) { throw new OrchestratorError('NETWORK_TEMPORARY_FAILURE', 'Gateway generation service is temporarily unavailable.', { status: 503, retryable: true, cause: error }); }
  const text = await response.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const upstreamCode = String(body?.code || 'ENDPOINT_GENERATION_DEPENDENCY_FAILURE');
    const retryable = body?.retryable === true || response.status === 429 || response.status >= 500;
    throw new OrchestratorError(upstreamCode, String(body?.message || 'Endpoint Test Design generation failed.'), { status: response.status, retryable, details: { upstreamStatus: response.status, upstreamCode } });
  }
  const data = body?.data;
  if (body?.status !== 'ok' || !data?.testDesignId || !data?.testDesignVersionId || !Number.isInteger(data?.testDesignVersion)) {
    throw new OrchestratorError('TEST_DESIGN_GENERATION_RESPONSE_INVALID', 'Gateway generation response is invalid.', { status: 502, retryable: true });
  }
  return data;
}
