import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autonomousRepository } from '../src/autonomous/repository.js';
import { normalizePolicy } from '../src/autonomous/contracts.js';
import { transition, nextCommand } from '../src/autonomous/workflow.js';
import { processLearningWake, recoverLearning } from '../src/autonomous/service.js';
import { DatabaseSync } from "node:sqlite";
class SQLitePreparedStatement {
    constructor(owner, sql, bindings = []) {
        this.owner = owner;
        this.sql = sql;
        this.bindings = bindings;
    }
    bind(...bindings) {
        return new SQLitePreparedStatement(this.owner, this.sql, bindings);
    }
    first() {
        const row = this.owner.raw.prepare(this.sql).get(...this.bindings);
        return row ?? null;
    }
    all() {
        const results = this.owner.raw.prepare(this.sql).all(...this.bindings);
        return { success: true, results };
    }
    run() {
        const result = this.owner.raw.prepare(this.sql).run(...this.bindings);
        return {
            success: true,
            meta: {
                changes: Number(result.changes || 0),
                last_row_id: Number(result.lastInsertRowid || 0),
            },
        };
    }
}
class SQLiteD1 {
    constructor({ beforeBatch = null } = {}) {
        this.raw = new DatabaseSync(":memory:");
        this.raw.exec("PRAGMA foreign_keys = ON");
        this.beforeBatch = beforeBatch;
        this.batchCount = 0;
    }
    prepare(sql) {
        return new SQLitePreparedStatement(this, sql);
    }
    async batch(statements) {
        this.batchCount += 1;
        if (this.beforeBatch)
            await this.beforeBatch(this, statements, this.batchCount);
        this.raw.exec("BEGIN IMMEDIATE");
        try {
            const results = statements.map((statement) => statement.run());
            this.raw.exec("COMMIT");
            return results;
        }
        catch (error) {
            this.raw.exec("ROLLBACK");
            throw error;
        }
    }
    exec(sql) {
        this.raw.exec(sql);
    }
    close() {
        this.raw.close();
    }
}
const scope = { organizationId: 'org_test', projectId: 'prj_test', environmentId: 'env_test' };
async function setup(limits = {}) { let time = Date.now(); const db = new SQLiteD1(); db.exec(readFileSync(new URL('../migrations/0002_autonomous_learning.sql', import.meta.url), 'utf8')); const env = { TEST_GENERATION_DB: db }, repo = autonomousRepository(env, { clock: () => time }); const input = normalizePolicy({ contractVersion: 'qagent.autonomous-learning-policy.v1', enabled: true, expectedRevision: 0, confirmDelegation: true, confirmControlledEnvironment: true, profile: 'CONTROLLED_READS_V1', allowedOrigins: ['https://fixture.invalid'], allowedChangeTypes: ['SCENARIO_READINESS_CONFIRMATION', 'ASSERTION_COVERAGE_EXTENSION'], expiresAt: new Date(time + 86400000).toISOString(), limits }, time); const policy = await repo.setPolicy(scope, input, 'usr_owner'); const start = { environmentId: scope.environmentId, policyRevision: 1, requestId: 'request_1' }; const { cycle } = await repo.createCycle(scope, start, 'usr_owner'); return { db, env, repo, policy, cycle, start, tick(ms) { time += ms; }, time: () => time, close: () => db.close() }; }
async function snap(c, n = 1) { const claimed = await c.repo.claimCycle(c.cycle.cycleId, 0); assert.ok(claimed); await c.repo.commitSnapshot(claimed, { endpoints: Array.from({ length: n }, (_, i) => ({ endpointId: 'cep_' + i, testDesignVersionId: 'tdv_' + i, testDesignVersion: 1 })), hasMore: false, nextCursor: null }); return c.repo.items(c.cycle.cycleId); }
async function prepared(c, item, scenarios = [{ scenarioId: 's', status: 'ANALYZE' }]) { const claimed = await c.repo.claimItem(item.itemId, item.revision); assert.ok(claimed); const op = await c.repo.reserve(claimed.cycle, claimed.item), result = { status: 'PREPARED', scenarios }; return c.repo.commit(claimed.item, op, result, transition(claimed.item.document, op.command, result, c.policy)); }
test('migration is additive and can be applied twice without deleting historical jobs', async () => { const c = await setup(); try {
    c.db.exec("CREATE TABLE original_jobs(id TEXT);INSERT INTO original_jobs VALUES('old')");
    c.db.exec(readFileSync(new URL('../migrations/0002_autonomous_learning.sql', import.meta.url), 'utf8'));
    assert.equal(c.db.raw.prepare('SELECT COUNT(*) n FROM original_jobs').get().n, 1);
}
finally {
    c.close();
} });
test('create is idempotent, survives a new repository instance, and refuses competing cycles', async () => { const c = await setup(); try {
    const r = autonomousRepository(c.env, { clock: c.time });
    const again = await r.createCycle(scope, c.start, 'usr_owner');
    assert.equal(again.reused, true);
    assert.equal(again.cycle.cycleId, c.cycle.cycleId);
    await assert.rejects(r.createCycle(scope, { ...c.start, requestId: 'different' }, 'usr_owner'), { code: 'AUTONOMOUS_CYCLE_ALREADY_ACTIVE' });
    assert.equal(await r.getCycle({ ...scope, organizationId: 'org_other' }, c.cycle.cycleId), null);
}
finally {
    c.close();
} });
test('only one claimant gets the same revision; expired lease can be recovered', async () => { const c = await setup(); try {
    const [a, b] = await Promise.all([c.repo.claimCycle(c.cycle.cycleId, 0), c.repo.claimCycle(c.cycle.cycleId, 0)]);
    assert.equal([a, b].filter(Boolean).length, 1);
    c.tick(300001);
    const recovered = await c.repo.claimCycle(c.cycle.cycleId, 0);
    assert.ok(recovered);
    assert.notEqual(recovered.leaseOwner, (a || b).leaseOwner);
    await assert.rejects(c.repo.commitSnapshot(a || b, { endpoints: [], hasMore: false }), { code: 'AUTONOMOUS_LEASE_LOST' });
}
finally {
    c.close();
} });
test('snapshot captures endpoint versions before processing any item', async () => { const c = await setup(); try {
    let a = await c.repo.claimCycle(c.cycle.cycleId, 0);
    await c.repo.commitSnapshot(a, { endpoints: [{ endpointId: 'cep_first', testDesignVersionId: 'tdv_first', testDesignVersion: 7 }], hasMore: true, nextCursor: 'cursor_2' });
    const i = (await c.repo.items(c.cycle.cycleId))[0];
    assert.equal(await c.repo.claimItem(i.itemId, 0), null);
    a = await c.repo.claimCycle(c.cycle.cycleId, 1);
    await c.repo.commitSnapshot(a, { endpoints: [], hasMore: false });
    assert.ok(await c.repo.claimItem(i.itemId, 0));
}
finally {
    c.close();
} });
test('snapshot refuses silent truncation above endpoint budget', async () => { const c = await setup({ maxEndpoints: 1 }); try {
    const a = await c.repo.claimCycle(c.cycle.cycleId, 0);
    await assert.rejects(c.repo.commitSnapshot(a, { endpoints: [1, 2].map(i => ({ endpointId: 'cep_' + i, testDesignVersionId: 'tdv_' + i, testDesignVersion: 1 })), hasMore: false }), { code: 'AUTONOMOUS_ENDPOINT_BUDGET_EXCEEDED' });
    assert.equal((await c.repo.items(c.cycle.cycleId)).length, 0);
}
finally {
    c.close();
} });
test('project item concurrency includes waiting Runs and does not restart active slots', async () => { const c = await setup({ concurrency: 1 }); try {
    const [a, b] = await snap(c, 2);
    await prepared(c, a);
    assert.equal(await c.repo.claimItem(b.itemId, 0), null);
    const current = await c.repo.getItem(a.itemId);
    assert.ok(await c.repo.claimItem(current.itemId, current.revision));
}
finally {
    c.close();
} });
test('pause and revoke stop private authorization, resume retains item and version', async () => { const c = await setup(); try {
    const [i] = await snap(c);
    const claim = await c.repo.claimItem(i.itemId, 0), op = await c.repo.reserve(claim.cycle, claim.item);
    const args = { cycleId: c.cycle.cycleId, itemId: i.itemId, operationId: op.operationId, leaseToken: claim.item.leaseOwner };
    await c.repo.grant(scope, args);
    await c.repo.control(scope, c.cycle.cycleId, 'PAUSE');
    await assert.rejects(c.repo.grant(scope, args));
    await c.repo.control(scope, c.cycle.cycleId, 'RESUME');
    assert.equal((await c.repo.grant(scope, args)).item.sourceVersionId, i.sourceVersionId);
    await c.repo.setPolicy(scope, { enabled: false, expectedRevision: 1 }, 'usr_owner');
    await assert.rejects(c.repo.grant(scope, args));
    await c.repo.wakes();
    assert.equal((await c.repo.getCycle(scope, c.cycle.cycleId)).status, 'CANCELLED');
}
finally {
    c.close();
} });
test('wrong tenant, command, operation or lease cannot authorize a private step', async () => { const c = await setup(); try {
    const [i] = await snap(c);
    const claim = await c.repo.claimItem(i.itemId, 0), op = await c.repo.reserve(claim.cycle, claim.item), a = { cycleId: c.cycle.cycleId, itemId: i.itemId, operationId: op.operationId, leaseToken: claim.item.leaseOwner };
    await assert.rejects(c.repo.grant({ ...scope, projectId: 'prj_other' }, a));
    await assert.rejects(c.repo.grant(scope, { ...a, leaseToken: 'wrong' }));
    await assert.rejects(c.repo.grant(scope, { ...a, operationId: 'other' }));
}
finally {
    c.close();
} });
test('scenario budget is a transactional cumulative guard across endpoint preparations', async () => { const c = await setup({ maxScenarios: 1 }); try {
    const [a, b] = await snap(c, 2);
    await prepared(c, a);
    await assert.rejects(prepared(c, b), { code: 'AUTONOMOUS_SCENARIO_BUDGET_EXHAUSTED' });
    const state = await c.repo.getItem(b.itemId);
    assert.equal(state.document.prepared, false);
    assert.equal(c.db.raw.prepare('SELECT SUM(scenario_units) n FROM autonomous_learning_operations').get().n, 1);
}
finally {
    c.close();
} });
test('operation budget counts stable reservations and does not recharge redelivery', async () => { const c = await setup({ maxAnalysisOperations: 1 }); try {
    const [a] = await snap(c);
    await prepared(c, a, [{ scenarioId: 's1', status: 'ANALYZE' }, { scenarioId: 's2', status: 'ANALYZE' }]);
    let i = await c.repo.getItem(a.itemId), claim = await c.repo.claimItem(i.itemId, i.revision), op = await c.repo.reserve(claim.cycle, claim.item);
    assert.equal((await c.repo.reserve(claim.cycle, claim.item)).operationId, op.operationId);
    const result = { status: 'NEEDS_ATTENTION', reasonCode: 'FIXTURE_BLOCKED' };
    await c.repo.commit(claim.item, op, result, transition(claim.item.document, op.command, result, c.policy));
    i = await c.repo.getItem(i.itemId);
    claim = await c.repo.claimItem(i.itemId, i.revision);
    await assert.rejects(c.repo.reserve(claim.cycle, claim.item), { code: 'AUTONOMOUS_OPERATION_BUDGET_EXHAUSTED' });
}
finally {
    c.close();
} });
test('commit rollback never stores a result if fenced item revision is lost', async () => { const c = await setup(); try {
    const [a] = await snap(c);
    const claim = await c.repo.claimItem(a.itemId, 0), op = await c.repo.reserve(claim.cycle, claim.item);
    c.db.raw.prepare('UPDATE autonomous_learning_items SET revision=revision+1 WHERE item_id=?').run(a.itemId);
    const r = { status: 'PREPARED', scenarios: [{ scenarioId: 's', status: 'ANALYZE' }] };
    await assert.rejects(c.repo.commit(claim.item, op, r, transition(claim.item.document, op.command, r, c.policy)));
    assert.equal(c.db.raw.prepare('SELECT result_json FROM autonomous_learning_operations WHERE operation_id=?').get(op.operationId).result_json, null);
}
finally {
    c.close();
} });
test('cron recovers persisted work after a lost queue publication', async () => { const c = await setup(); try {
    let delivered = [];
    c.env.AUTONOMOUS_LEARNING_QUEUE = { send: async (m) => delivered.push(m) };
    const r = await recoverLearning(c.env, { repo: c.repo });
    assert.equal(r.recovered, 1);
    assert.equal(delivered[0].cycleId, c.cycle.cycleId);
}
finally {
    c.close();
} });
test('a blocked item does not prevent another endpoint completing', async () => { const c = await setup(); try {
    const [a, b] = await snap(c, 2);
    await prepared(c, a, [{ scenarioId: 'blocked', status: 'NEEDS_ATTENTION', reasonCode: 'DATA_REQUIRED' }]);
    await prepared(c, b, [{ scenarioId: 'ready', status: 'ALREADY_READY' }]);
    await c.repo.finishCycle(c.cycle.cycleId);
    const out = await c.repo.publicCycle(scope, c.cycle.cycleId);
    assert.equal(out.status, 'COMPLETED_WITH_EXCEPTIONS');
    assert.equal(out.summary.needsAttention, 1);
    assert.equal(out.summary.alreadyReady, 1);
    assert.ok(!JSON.stringify(out).includes('leaseOwner'));
    assert.equal(out.executionStartedByThisRead, false);
}
finally {
    c.close();
} });
test('deadline expires existing work without starting new cycles', async () => { const c = await setup({ maxDurationSeconds: 60 }); try {
    c.tick(60001);
    assert.deepEqual(await c.repo.wakes(), []);
    assert.equal((await c.repo.getCycle(scope, c.cycle.cycleId)).status, 'EXPIRED');
    assert.equal(c.db.raw.prepare('SELECT COUNT(*) n FROM autonomous_learning_cycles').get().n, 1);
}
finally {
    c.close();
} });
test('poisoned wake cannot claim an item belonging to another cycle', async () => { const c = await setup(); try {
    const [i] = await snap(c);
    let ack = 0, calls = 0;
    await processLearningWake({ body: { contractVersion: 'qagent.autonomous-learning-wake.v1', cycleId: 'alc_other', itemId: i.itemId, revision: 0 }, ack() { ack++; } }, c.env, { repo: c.repo, call: async () => { calls++; } });
    assert.equal(ack, 1);
    assert.equal(calls, 0);
    assert.equal((await c.repo.getItem(i.itemId)).status, 'PENDING');
}
finally {
    c.close();
} });
test('queue wake advances one step, handles redelivery and needs no browser process', async () => { const c = await setup(); try {
    let calls = 0;
    const messages = [];
    c.env.AUTONOMOUS_LEARNING_QUEUE = { send: async (m) => messages.push(m) };
    await recoverLearning(c.env, { repo: c.repo });
    const w = messages.shift();
    const call = async (_env, _c, operation) => { calls++; return operation === 'snapshot' ? { endpoints: [{ endpointId: 'cep_one', testDesignVersionId: 'tdv_one', testDesignVersion: 1 }], hasMore: false } : { status: 'PREPARED', scenarios: [{ scenarioId: 'ready', status: 'ALREADY_READY' }] }; };
    let ack = 0;
    await processLearningWake({ body: w, ack() { ack++; } }, c.env, { repo: c.repo, call });
    await processLearningWake({ body: w, ack() { ack++; } }, c.env, { repo: c.repo, call });
    assert.equal(calls, 1);
    await processLearningWake({ body: messages.shift(), ack() { ack++; } }, c.env, { repo: c.repo, call });
    assert.equal(calls, 2);
    assert.equal((await c.repo.getCycle(scope, c.cycle.cycleId)).status, 'COMPLETED');
    assert.equal(ack, 3);
}
finally {
    c.close();
} });

for(const action of ['PAUSE','CANCEL'])test('late snapshot failure cannot undo '+action,async()=>{const c=await setup();try{const a=await c.repo.claimCycle(c.cycle.cycleId,0);await c.repo.control(scope,c.cycle.cycleId,action);await c.repo.snapshotError(a,'AUTONOMOUS_GATEWAY_TIMEOUT',true);assert.equal((await c.repo.getCycle(scope,c.cycle.cycleId)).status,action==='PAUSE'?'PAUSED':'CANCELLED');}finally{c.close();}});
test('pause while waiting for an authorization does not fail the resumable item',async()=>{const c=await setup();try{const [i]=await snap(c),a=await c.repo.claimItem(i.itemId,0);await c.repo.control(scope,c.cycle.cycleId,'PAUSE');await c.repo.finishItem(a.item,'AUTONOMOUS_AUTHORIZATION_INACTIVE',false);const held=await c.repo.getItem(i.itemId);assert.equal(held.status,'ACTIVE');assert.equal(held.errorCount,0);assert.deepEqual(held.document,a.item.document);await c.repo.control(scope,c.cycle.cycleId,'RESUME');c.tick(11000);assert.ok(await c.repo.claimItem(i.itemId,held.revision));}finally{c.close();}});
