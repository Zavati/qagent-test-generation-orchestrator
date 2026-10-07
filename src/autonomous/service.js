import { autonomousRepository } from './repository.js';
import { MESSAGE_CONTRACT, safeCode, ID, failure } from './contracts.js';
import { callLearningGateway } from './gatewayClient.js';
import { nextCommand, transition } from './workflow.js';
export async function publishWake(env, wake, { delaySeconds = 0, repo = autonomousRepository(env) } = {}) {
    if (!env.AUTONOMOUS_LEARNING_QUEUE?.send)
        failure('AUTONOMOUS_QUEUE_NOT_CONFIGURED', 503, true);
    await env.AUTONOMOUS_LEARNING_QUEUE.send({ contractVersion: MESSAGE_CONTRACT, ...wake }, { delaySeconds: Math.max(0, Math.min(86400, Math.ceil(delaySeconds))) });
    await repo.enqueued(wake);
}
export async function recoverLearning(env, deps = {}) { const repo = deps.repo || autonomousRepository(env); const wakes = await repo.wakes(); let count = 0; for (const w of wakes) {
    try {
        await (deps.publish || publishWake)(env, w, { repo });
        count++;
    }
    catch (e) {
        console.warn(JSON.stringify({ event: 'autonomous_learning_wake_deferred', code: safeCode(e) }));
    }
} return { recovered: count }; }
export async function processLearningWake(message, env, deps = {}) {
    const w = message?.body;
    if (!w || Object.keys(w).some(k => !['contractVersion', 'cycleId', 'itemId', 'revision'].includes(k)) || w.contractVersion !== MESSAGE_CONTRACT || !ID.test(w.cycleId || '') || (w.itemId !== null && !ID.test(w.itemId || '')) || !Number.isInteger(w.revision) || w.revision < 0) {
        message?.ack?.();
        return { ignored: true };
    }
    const repo = deps.repo || autonomousRepository(env), call = deps.call || callLearningGateway, publish = deps.publish || publishWake;
    if (!w.itemId) {
        const c = await repo.claimCycle(w.cycleId, w.revision);
        if (!c) {
            message.ack();
            return { ignored: true };
        }
        try {
            const result = await call(env, c, 'snapshot', { cycleId: c.cycleId, leaseToken: c.leaseOwner });
            const saved = await repo.commitSnapshot(c, result);
            message.ack();
            if (saved.phase === 'SNAPSHOT')
                await publish(env, { cycleId: saved.cycleId, itemId: null, revision: saved.revision }, { repo }).catch(() => { });
            else
                await recoverLearning(env, { ...deps, repo });
            return { status: 'SNAPSHOT_SAVED' };
        }
        catch (e) {
            await repo.snapshotError(c, safeCode(e), e.retryable === true || e.status >= 500);
            message.ack();
            return { status: 'SNAPSHOT_DEFERRED', code: safeCode(e) };
        }
    }
    const beforeClaim = await repo.getItem(w.itemId);
    if (!beforeClaim || beforeClaim.cycleId !== w.cycleId) {
        message.ack();
        return { ignored: true };
    }
    const claimed = await repo.claimItem(w.itemId, w.revision);
    if (!claimed) {
        message.ack();
        return { ignored: true };
    }
    const { cycle: c, item: i } = claimed;
    if (c.cycleId !== w.cycleId) {
        await repo.finishItem(i, 'AUTONOMOUS_WAKE_SCOPE_MISMATCH');
        message.ack();
        return { ignored: true };
    }
    try {
        const command = nextCommand(i.document);
        if (command.kind === 'DONE')
            failure('AUTONOMOUS_TERMINAL_ITEM_INVALID');
        const op = await repo.reserve(c, i);
        const result = op.cached || await call(env, c, 'step', { cycleId: c.cycleId, itemId: i.itemId, operationId: op.operationId, leaseToken: i.leaseOwner });
        const update = transition(i.document, command, result, c.policy), saved = await repo.commit(i, op, result, update);
        await repo.finishCycle(c.cycleId);
        message.ack();
        console.info(JSON.stringify({ event: 'autonomous_learning_step_completed', cycleId: c.cycleId, itemId: i.itemId, step: command.kind, status: saved.status }));
        const current = await repo.getCycleAny(c.cycleId);
        if (current?.status === 'RUNNING' && saved.status === 'ACTIVE')
            await publish(env, { cycleId: c.cycleId, itemId: i.itemId, revision: saved.revision }, { repo, delaySeconds: update.delaySeconds }).catch(() => { });
        if (saved.status !== 'ACTIVE')
            await recoverLearning(env, { ...deps, repo });
        return { status: saved.status };
    }
    catch (e) {
        const saved = await repo.finishItem(i, safeCode(e), e.retryable === true || e.status >= 500);
        await repo.finishCycle(c.cycleId);
        message.ack();
        console.warn(JSON.stringify({ event: 'autonomous_learning_step_deferred', cycleId: c.cycleId, itemId: i.itemId, code: safeCode(e), status: saved?.status }));
        if (saved?.status === 'ACTIVE')
            try {
                await publish(env, { cycleId: c.cycleId, itemId: i.itemId, revision: saved.revision }, { repo, delaySeconds: 10 * (saved.errorCount || 1) });
            }
            catch { }
        else
            await recoverLearning(env, { ...deps, repo });
        return { status: saved?.status || 'DEFERRED', code: safeCode(e) };
    }
}
