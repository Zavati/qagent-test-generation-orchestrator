import { verifyInternalRequest } from '../security/internalAuth.js';
import { autonomousRepository } from './repository.js';
import { normalizePolicy, normalizeCycleStart, identifier, exact, failure } from './contracts.js';
import { publishWake, recoverLearning } from './service.js';
async function parseBody(req) {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 32768)
        failure('AUTONOMOUS_INPUT_TOO_LARGE', 413);
    let raw = '', size = 0;
    const reader = req.body?.getReader(), decoder = new TextDecoder();
    if (reader)
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                size += value.byteLength;
                if (size > 32768) {
                    await reader.cancel();
                    failure('AUTONOMOUS_INPUT_TOO_LARGE', 413);
                }
                raw += decoder.decode(value, { stream: true });
            }
            raw += decoder.decode();
        }
        finally {
            reader.releaseLock();
        }
    let input;
    try {
        input = raw ? JSON.parse(raw) : {};
    }
    catch {
        failure('AUTONOMOUS_JSON_INVALID', 400);
    }
    return { raw, input };
}
export async function autonomousRoute(req, env, deps = {}) {
    const u = new URL(req.url), m = u.pathname.match(/^\/v1\/autonomous-learning\/projects\/([^/]+)\/(policy|cycles)(?:\/([^/]+)(?:\/(control|authorize))?)?$/);
    if (!m)
        return null;
    const projectId = identifier(decodeURIComponent(m[1])), resource = m[2], cycleId = m[3] ? identifier(decodeURIComponent(m[3])) : null, action = m[4];
    const { raw, input } = await parseBody(req), auth = await (deps.verify || verifyInternalRequest)(req, env, { rawBody: raw });
    if (auth.projectId !== projectId)
        failure('AUTONOMOUS_SCOPE_MISMATCH', 403);
    const scope = { organizationId: auth.organizationId, projectId }, repo = deps.repo || autonomousRepository(env);
    if (resource === 'policy' && !cycleId) {
        const environmentId = identifier(u.searchParams.get('environmentId'));
        if (req.method === 'GET')
            return { status: 200, body: { status: 'ok', data: { policy: await repo.policy({ ...scope, environmentId }) } } };
        if (req.method === 'PUT') {
            exact(input, ['policy', 'actorUserId']);
            const p = await repo.setPolicy({ ...scope, environmentId }, normalizePolicy(input.policy), identifier(input.actorUserId));
            return { status: 200, body: { status: 'ok', data: { policy: p } } };
        }
    }
    if (resource === 'cycles' && !cycleId) {
        if (req.method === 'GET')
            return { status: 200, body: { status: 'ok', data: { cycles: await repo.listCycles({ ...scope, environmentId: identifier(u.searchParams.get('environmentId')) }) } } };
        if (req.method === 'POST') {
            exact(input, ['start', 'actorUserId']);
            const start = normalizeCycleStart(input.start);
            if (!env.AUTONOMOUS_LEARNING_QUEUE?.send && !deps.publish)
                failure('AUTONOMOUS_QUEUE_NOT_CONFIGURED', 503);
            const result = await repo.createCycle(scope, start, identifier(input.actorUserId));
            // Failure to publish is recoverable from D1 through cron, not a lost cycle.
            let dispatch = 'QUEUED';
            try {
                await (deps.publish || publishWake)(env, { cycleId: result.cycle.cycleId, itemId: null, revision: result.cycle.revision }, { repo });
            }
            catch {
                dispatch = 'RECOVERY_PENDING';
            }
            return { status: 202, body: { status: 'ok', data: { cycle: await repo.publicCycle(scope, result.cycle.cycleId), reused: result.reused, dispatch } } };
        }
    }
    if (resource === 'cycles' && cycleId) {
        if (!action && req.method === 'GET')
            return { status: 200, body: { status: 'ok', data: await repo.publicCycle(scope, cycleId) } };
        if (action === 'control' && req.method === 'POST') {
            exact(input, ['action']);
            await repo.control(scope, cycleId, input.action);
            if (input.action === 'RESUME')
                await (deps.recover || recoverLearning)(env, { repo });
            return { status: 200, body: { status: 'ok', data: await repo.publicCycle(scope, cycleId) } };
        }
        if (action === 'authorize' && req.method === 'POST') {
            exact(input, ['itemId', 'operationId', 'leaseToken']);
            identifier(input.leaseToken);
            if (input.itemId)
                identifier(input.itemId);
            if (input.operationId)
                identifier(input.operationId);
            return { status: 200, body: { status: 'ok', data: await repo.grant(scope, { cycleId, ...input }) } };
        }
    }
    failure('AUTONOMOUS_METHOD_NOT_ALLOWED', 405);
}
