export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function readJson(request, { maxBytes = 32_768 } = {}) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    const error = new Error('Request body is too large.');
    error.code = 'REQUEST_BODY_TOO_LARGE';
    error.status = 413;
    throw error;
  }
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch {
    const error = new Error('Request body must be valid JSON.');
    error.code = 'INVALID_JSON';
    error.status = 400;
    throw error;
  }
}
