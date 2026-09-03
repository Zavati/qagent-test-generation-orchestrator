import { OrchestratorError } from '../lib/errors.js';

const INTERNAL_BASE = 'https://qagent-catalog.internal';

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function canonicalize(searchParams) {
  return Array.from(searchParams.entries())
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}
async function signature({ secret, url, organizationId, projectId, timestamp }) {
  if (String(secret || '').length < 32) throw new OrchestratorError('CATALOG_QUERY_NOT_CONFIGURED', 'Catalog Query HMAC secret is not configured.', { status: 503, retryable: true });
  const parsed = new URL(url);
  const payload = ['qagent.catalog-query.v1', 'GET', parsed.pathname, canonicalize(parsed.searchParams), organizationId, projectId, timestamp].join('\n');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}
async function requestPage({ env, organizationId, projectId, cursor = null, fetchImpl = null }) {
  const binding = env?.CATALOG_QUERY_SERVICE;
  if (!fetchImpl && (!binding || typeof binding.fetch !== 'function')) {
    throw new OrchestratorError('CATALOG_QUERY_NOT_CONFIGURED', 'Catalog service binding is not configured.', { status: 503, retryable: true });
  }
  const url = new URL(`${INTERNAL_BASE}/v1/catalog/projects/${encodeURIComponent(projectId)}/endpoints`);
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('cursor', cursor);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await signature({ secret: env?.CATALOG_QUERY_HMAC_SECRET, url, organizationId, projectId, timestamp });
  const request = new Request(url.toString(), { headers: {
    Accept: 'application/json',
    'X-QAgent-Organization-Id': organizationId,
    'X-QAgent-Project-Id': projectId,
    'X-QAgent-Query-Timestamp': timestamp,
    'X-QAgent-Query-Signature': sig,
  }});
  let response;
  try { response = fetchImpl ? await fetchImpl(request) : await binding.fetch(request); }
  catch (error) { throw new OrchestratorError('DEPENDENCY_TEMPORARY_FAILURE', 'Catalog service is temporarily unavailable.', { status: 503, retryable: true, cause: error }); }
  const text = await response.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new OrchestratorError('DEPENDENCY_TEMPORARY_FAILURE', 'Catalog endpoint snapshot could not be loaded.', { status: response.status >= 500 ? 503 : 502, retryable: response.status >= 500 || response.status === 429, details: { upstreamStatus: response.status, upstreamCode: body?.code || null } });
  if (body?.status !== 'ok' || !Array.isArray(body?.data) || !body?.page) throw new OrchestratorError('CATALOG_RESPONSE_INVALID', 'Catalog returned an invalid endpoint snapshot.', { status: 502, retryable: false });
  return { items: body.data, nextCursor: body.page.nextCursor || null, hasMore: body.page.hasMore === true };
}

export async function listAllProjectEndpoints({ env, organizationId, projectId, fetchImpl = null }) {
  const all = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await requestPage({ env, organizationId, projectId, cursor, fetchImpl });
    for (const item of result.items) {
      const endpointId = String(item?.endpointId || '').trim();
      if (!endpointId || seen.has(endpointId)) continue;
      seen.add(endpointId); all.push(item);
    }
    if (!result.hasMore || !result.nextCursor) return all;
    if (result.nextCursor === cursor) throw new OrchestratorError('CATALOG_CURSOR_INVALID', 'Catalog pagination did not advance.', { status: 502, retryable: false });
    cursor = result.nextCursor;
  }
  throw new OrchestratorError('CATALOG_SNAPSHOT_TOO_LARGE', 'Catalog endpoint snapshot exceeded the supported page count.', { status: 409, retryable: false });
}
