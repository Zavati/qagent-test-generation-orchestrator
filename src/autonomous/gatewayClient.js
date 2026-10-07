import { buildInternalHeaders } from '../security/internalAuth.js';
import { failure } from './contracts.js';
export async function callLearningGateway(env, scope, path, input, { timeoutMs = 240000 } = {}) {
    const binding = env.TEST_DESIGN_GENERATION_SERVICE;
    if (!binding?.fetch)
        failure('AUTONOMOUS_GATEWAY_NOT_CONFIGURED', 503, true);
    const url = 'https://api.apiqagent.com/internal/v1/autonomous-learning/' + path, rawBody = JSON.stringify(input);
    const headers = await buildInternalHeaders({ env, ...scope, method: 'POST', url, rawBody });
    const controller = new AbortController();
    let timer, reader;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error('AUTONOMOUS_GATEWAY_TIMEOUT'); Object.assign(e, { code: 'AUTONOMOUS_GATEWAY_TIMEOUT', status: 503, retryable: true }); reject(e); controller.abort(); reader?.cancel().catch(() => { }); }, Math.max(10, Math.min(240000, timeoutMs))); });
    try {
        const response = await Promise.race([binding.fetch(new Request(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: rawBody, signal: controller.signal })), deadline]);
        let raw = '', bytes = 0;
        const decoder = new TextDecoder();
        reader = response.body?.getReader();
        if (reader)
            try {
                for (;;) {
                    const { done, value } = await Promise.race([reader.read(), deadline]);
                    if (done)
                        break;
                    bytes += value.byteLength;
                    if (bytes > 1048576) {
                        await reader.cancel();
                        failure('AUTONOMOUS_GATEWAY_RESPONSE_TOO_LARGE', 502);
                    }
                    raw += decoder.decode(value, { stream: true });
                }
                raw += decoder.decode();
            }
            finally {
                reader.releaseLock();
            }
        let body;
        try {
            body = JSON.parse(raw);
        }
        catch {
            failure('AUTONOMOUS_GATEWAY_RESPONSE_INVALID', 502, true);
        }
        if (!response.ok || body?.status !== 'ok')
            failure(/^[A-Z][A-Z0-9_]{1,119}$/.test(body?.code || '') ? body.code : 'AUTONOMOUS_GATEWAY_FAILED', response.status >= 400 ? response.status : 502, response.status >= 500 || response.status === 429 || body.retryable === true);
        return body.data;
    }
    catch (e) {
        if (e?.code)
            throw e;
        failure('AUTONOMOUS_GATEWAY_UNAVAILABLE', 503, true);
    }
    finally {
        clearTimeout(timer);
    }
}
