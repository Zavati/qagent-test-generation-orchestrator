import { OrchestratorError } from '../lib/errors.js';
const INTERNAL_BASE = 'https://qagent-test-registry.internal';

export async function getProjectTestInventory({ env, organizationId, projectId, fetchImpl = null }) {
  const binding = env?.TEST_REGISTRY_SERVICE;
  if (!fetchImpl && (!binding || typeof binding.fetch !== 'function')) {
    throw new OrchestratorError('TEST_REGISTRY_NOT_CONFIGURED', 'Test Registry service binding is not configured.', { status: 503, retryable: true });
  }
  const request = new Request(`${INTERNAL_BASE}/v1/test-registry/projects/${encodeURIComponent(projectId)}/test-inventory`, {
    headers: { Accept: 'application/json', 'X-QAgent-Organization-Id': organizationId, 'X-QAgent-Project-Id': projectId },
  });
  let response;
  try { response = fetchImpl ? await fetchImpl(request) : await binding.fetch(request); }
  catch (error) { throw new OrchestratorError('DEPENDENCY_TEMPORARY_FAILURE', 'Test Registry is temporarily unavailable.', { status: 503, retryable: true, cause: error }); }
  const text = await response.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new OrchestratorError('DEPENDENCY_TEMPORARY_FAILURE', 'Test Registry inventory could not be loaded.', { status: response.status >= 500 ? 503 : 502, retryable: response.status >= 500 || response.status === 429, details: { upstreamStatus: response.status, upstreamCode: body?.code || null } });
  const data = body?.data;
  if (body?.status !== 'ok' || data?.organizationId !== organizationId || data?.projectId !== projectId || !Array.isArray(data?.items)) {
    throw new OrchestratorError('TEST_REGISTRY_INVENTORY_RESPONSE_INVALID', 'Test Registry returned an invalid Project Test Inventory.', { status: 502, retryable: false });
  }
  return data;
}
