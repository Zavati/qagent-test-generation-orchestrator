import { canonical, digest, failure, activePolicy, summarizeItems, CYCLE_CONTRACT } from './contracts.js';
import { initialDocument, nextCommand, operationKind } from './workflow.js';
const parse = x => x ? JSON.parse(x) : null;
const changes = x => Number(x?.meta?.changes || 0);
const iso = ms => new Date(ms).toISOString();
/** D1 batch guards are transactional. Leases fence writes; side effects retain
 * their own idempotency keys when a reply is lost or a worker is redelivered. */
export function autonomousRepository(env, { clock = () => Date.now() } = {}) {
    const db = env.TEST_GENERATION_DB;
    if (!db?.prepare)
        failure('AUTONOMOUS_DB_NOT_CONFIGURED', 503, true);
    const first = (s, ...v) => db.prepare(s).bind(...v).first();
    const run = (s, ...v) => db.prepare(s).bind(...v).run();
    const all = async (s, ...v) => (await db.prepare(s).bind(...v).all()).results || [];
    const cycleRow = r => r ? { cycleId: r.cycle_id, organizationId: r.organization_id, projectId: r.project_id, environmentId: r.environment_id, policyId: r.policy_id, policyRevision: r.policy_revision, policyHash: r.policy_hash, policy: parse(r.policy_json), requestedByUserId: r.requested_by_user_id, status: r.status, phase: r.phase, cursor: parse(r.cursor_json), endpointCount: r.endpoint_count, snapshotComplete: !!r.snapshot_complete, revision: r.revision, leaseOwner: r.lease_owner, leaseExpiresAt: r.lease_expires_at, wakeAt: r.wake_at, errorCount: r.error_count, errorCode: r.error_code, createdAt: r.created_at, updatedAt: r.updated_at, deadline: r.deadline } : null;
    const itemRow = r => r ? { itemId: r.item_id, cycleId: r.cycle_id, organizationId: r.organization_id, projectId: r.project_id, endpointId: r.endpoint_id, sourceVersionId: r.source_version_id, sourceVersion: r.source_version, status: r.status, document: parse(r.document_json), revision: r.revision, leaseOwner: r.lease_owner, leaseExpiresAt: r.lease_expires_at, wakeAt: r.wake_at, errorCount: r.error_count, errorCode: r.error_code, updatedAt: r.updated_at } : null;
    async function policy(scope) { const row = await first('SELECT policy_json FROM autonomous_learning_policies WHERE organization_id=? AND project_id=? AND environment_id=? ORDER BY revision DESC LIMIT 1', scope.organizationId, scope.projectId, scope.environmentId); return row ? parse(row.policy_json) : null; }
    async function setPolicy(scope, input, actor) {
        const old = await policy(scope);
        if ((old?.revision || 0) !== input.expectedRevision)
            failure('AUTONOMOUS_POLICY_REVISION_CONFLICT');
        const policyId = 'alp_' + (await digest([scope.organizationId, scope.projectId, scope.environmentId])).slice(0, 40), createdAt = iso(clock()), revision = input.expectedRevision + 1;
        const fields = input.enabled ? { profile: input.profile, allowedOrigins: input.allowedOrigins, allowedChangeTypes: input.allowedChangeTypes, limits: input.limits, expiresAt: input.expiresAt } : { profile: old?.profile || 'CONTROLLED_READS_V1', allowedOrigins: old?.allowedOrigins || [], allowedChangeTypes: old?.allowedChangeTypes || [], limits: old?.limits || {}, expiresAt: old?.expiresAt || createdAt };
        const p = { contractVersion: 'qagent.autonomous-learning-policy.v1', ...scope, ...fields, policyId, revision, enabled: input.enabled, delegatedByUserId: actor, delegatedAt: createdAt };
        p.policyHash = await digest(p);
        const result = await run(`INSERT INTO autonomous_learning_policies(policy_id,revision,organization_id,project_id,environment_id,enabled,policy_hash,policy_json,created_at)
   SELECT ?,?,?,?,?,?,?,?,? WHERE ?=(SELECT COALESCE(MAX(revision),0) FROM autonomous_learning_policies WHERE policy_id=?)`, policyId, revision, scope.organizationId, scope.projectId, scope.environmentId, p.enabled ? 1 : 0, p.policyHash, canonical(p), createdAt, input.expectedRevision, policyId);
        if (!changes(result))
            failure('AUTONOMOUS_POLICY_REVISION_CONFLICT');
        return p;
    }
    const getCycle = async (scope, id) => cycleRow(await first('SELECT * FROM autonomous_learning_cycles WHERE cycle_id=? AND organization_id=? AND project_id=?', id, scope.organizationId, scope.projectId));
    const getCycleAny = async (id) => cycleRow(await first('SELECT * FROM autonomous_learning_cycles WHERE cycle_id=?', id));
    const getItem = async (id) => itemRow(await first('SELECT * FROM autonomous_learning_items WHERE item_id=?', id));
    const items = async (id) => (await all('SELECT * FROM autonomous_learning_items WHERE cycle_id=? ORDER BY endpoint_id', id)).map(itemRow);
    async function createCycle(scope, input, actor) {
        const p = await policy({ ...scope, environmentId: input.environmentId });
        if (!p?.enabled || p.revision !== input.policyRevision || Date.parse(p.expiresAt) <= clock())
            failure('AUTONOMOUS_POLICY_NOT_ACTIVE');
        const hash = await digest({ environmentId: input.environmentId, policyId: p.policyId, policyRevision: p.revision });
        const previous = await first('SELECT * FROM autonomous_learning_cycles WHERE organization_id=? AND project_id=? AND request_id=?', scope.organizationId, scope.projectId, input.requestId);
        if (previous) {
            if (previous.request_hash !== hash)
                failure('AUTONOMOUS_REQUEST_ID_CONFLICT');
            return { cycle: cycleRow(previous), reused: true };
        }
        const now = iso(clock()), id = 'alc_' + crypto.randomUUID(), deadline = iso(Math.min(Date.parse(p.expiresAt), clock() + p.limits.maxDurationSeconds * 1000));
        try {
            const q = await run(`INSERT INTO autonomous_learning_cycles(cycle_id,organization_id,project_id,environment_id,policy_id,policy_revision,policy_hash,policy_json,requested_by_user_id,request_id,request_hash,status,phase,wake_at,created_at,updated_at,deadline)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'RUNNING','SNAPSHOT',?,?,?,? WHERE EXISTS(SELECT 1 FROM autonomous_learning_policies WHERE policy_id=? AND revision=? AND enabled=1 AND revision=(SELECT MAX(revision) FROM autonomous_learning_policies WHERE policy_id=?))`, id, scope.organizationId, scope.projectId, p.environmentId, p.policyId, p.revision, p.policyHash, canonical(p), actor, input.requestId, hash, now, now, now, deadline, p.policyId, p.revision, p.policyId);
            if (!changes(q))
                failure('AUTONOMOUS_POLICY_NOT_ACTIVE');
        }
        catch (e) {
            const replay = await first('SELECT * FROM autonomous_learning_cycles WHERE organization_id=? AND project_id=? AND request_id=?', scope.organizationId, scope.projectId, input.requestId);
            if (replay) {
                if (replay.request_hash !== hash)
                    failure('AUTONOMOUS_REQUEST_ID_CONFLICT');
                return { cycle: cycleRow(replay), reused: true };
            }
            if (/UNIQUE constraint/i.test(String(e.message)))
                failure('AUTONOMOUS_CYCLE_ALREADY_ACTIVE');
            throw e;
        }
        return { cycle: await getCycle(scope, id), reused: false };
    }
    async function control(scope, id, action) {
        const c = await getCycle(scope, id);
        if (!c)
            failure('AUTONOMOUS_CYCLE_NOT_FOUND', 404);
        if (!['PAUSE', 'RESUME', 'CANCEL'].includes(action))
            failure('AUTONOMOUS_CONTROL_INVALID', 400);
        if (!['RUNNING', 'PAUSED'].includes(c.status))
            return c;
        if (action === 'RESUME' && (!activePolicy(await policy(c), c, clock()) || Date.parse(c.deadline) <= clock()))
            failure('AUTONOMOUS_POLICY_NOT_ACTIVE');
        const status = action === 'CANCEL' ? 'CANCELLED' : action === 'PAUSE' ? 'PAUSED' : 'RUNNING';
        await run("UPDATE autonomous_learning_cycles SET status=?,updated_at=?,wake_at=? WHERE cycle_id=? AND status IN ('RUNNING','PAUSED')", status, iso(clock()), iso(clock()), id);
        return getCycle(scope, id);
    }
    async function live(c) { return c.status === 'RUNNING' && Date.parse(c.deadline) > clock() && activePolicy(await policy(c), c, clock()); }
    async function settleInactive(c) { if (!['RUNNING', 'PAUSED'].includes(c.status))
        return false; const expired = Date.parse(c.deadline) <= clock(); const p = await policy(c); if (expired || !activePolicy(p, c, clock())) {
        await run("UPDATE autonomous_learning_cycles SET status=?,error_code=?,updated_at=? WHERE cycle_id=? AND status IN ('RUNNING','PAUSED')", expired ? 'EXPIRED' : 'CANCELLED', expired ? 'AUTONOMOUS_CYCLE_DEADLINE' : 'AUTONOMOUS_POLICY_REVOKED', iso(clock()), c.cycleId);
        return false;
    } return c.status === 'RUNNING'; }
    async function claimCycle(id, revision) {
        let c = await getCycleAny(id);
        if (!c || !await settleInactive(c) || c.phase !== 'SNAPSHOT')
            return null;
        const token = crypto.randomUUID(), now = iso(clock()), until = iso(clock() + 300000);
        const result = await run("UPDATE autonomous_learning_cycles SET lease_owner=?,lease_expires_at=? WHERE cycle_id=? AND revision=? AND status='RUNNING' AND phase='SNAPSHOT' AND wake_at<=? AND (lease_owner IS NULL OR lease_expires_at<=?)", token, until, id, revision, now, now);
        return changes(result) ? getCycleAny(id) : null;
    }
    async function commitSnapshot(c, result) {
        if (!Array.isArray(result.endpoints) || result.endpoints.length > 25 || typeof result.hasMore !== 'boolean' || (result.hasMore && typeof result.nextCursor !== 'string'))
            failure('AUTONOMOUS_SNAPSHOT_INVALID', 502);
        if (c.endpointCount + result.endpoints.length > c.policy.limits.maxEndpoints)
            failure('AUTONOMOUS_ENDPOINT_BUDGET_EXCEEDED');
        const now = iso(clock()), stmts = [];
        for (const e of result.endpoints) {
            if (typeof e.endpointId !== 'string' || typeof e.testDesignVersionId !== 'string' || !Number.isInteger(e.testDesignVersion) || e.testDesignVersion < 1)
                failure('AUTONOMOUS_SNAPSHOT_INVALID', 502);
            const prior = await first('SELECT source_version_id FROM autonomous_learning_items WHERE cycle_id=? AND endpoint_id=?', c.cycleId, e.endpointId);
            if (prior)
                failure('AUTONOMOUS_INVENTORY_CHANGED');
            const id = 'ali_' + (await digest([c.cycleId, e.endpointId])).slice(0, 40);
            stmts.push(db.prepare(`INSERT INTO autonomous_learning_items(item_id,cycle_id,organization_id,project_id,endpoint_id,source_version_id,source_version,status,document_json,wake_at,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,'PENDING',?,?,?,? WHERE EXISTS(SELECT 1 FROM autonomous_learning_cycles WHERE cycle_id=? AND lease_owner=? AND revision=?)`).bind(id, c.cycleId, c.organizationId, c.projectId, e.endpointId, e.testDesignVersionId, e.testDesignVersion, canonical(initialDocument()), now, now, now, c.cycleId, c.leaseOwner, c.revision));
        }
        const next = result.hasMore ? result.nextCursor : null;
        stmts.push(db.prepare(`UPDATE autonomous_learning_cycles SET cursor_json=?,endpoint_count=endpoint_count+?,snapshot_complete=?,phase=?,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,error_count=0,error_code=NULL,wake_at=?,updated_at=? WHERE cycle_id=? AND lease_owner=? AND revision=?`).bind(next ? canonical(next) : null, result.endpoints.length, result.hasMore ? 0 : 1, result.hasMore ? 'SNAPSHOT' : 'PROCESSING', now, now, c.cycleId, c.leaseOwner, c.revision));
        const saved = await db.batch(stmts);
        if (!changes(saved.at(-1)))
            failure('AUTONOMOUS_LEASE_LOST', 409, true);
        return getCycleAny(c.cycleId);
    }
    async function snapshotError(c, code, retryable) { const count = c.errorCount + 1, now = clock(); await run(`UPDATE autonomous_learning_cycles SET status=CASE WHEN status='PAUSED' THEN status ELSE ? END,error_count=CASE WHEN status='PAUSED' THEN error_count ELSE ? END,error_code=CASE WHEN status='PAUSED' THEN NULL ELSE ? END,lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,wake_at=?,updated_at=? WHERE cycle_id=? AND lease_owner=? AND status IN ('RUNNING','PAUSED')`, retryable && count < 3 ? 'RUNNING' : 'FAILED', count, code, iso(now + count * 10000), iso(now), c.cycleId, c.leaseOwner); }
    async function claimItem(id, revision) {
        const i = await getItem(id);
        if (!i || !['PENDING', 'ACTIVE'].includes(i.status))
            return null;
        const c = await getCycleAny(i.cycleId);
        if (!c || !await settleInactive(c) || c.phase !== 'PROCESSING')
            return null;
        const token = crypto.randomUUID(), now = iso(clock());
        const q = await run(`UPDATE autonomous_learning_items SET status='ACTIVE',lease_owner=?,lease_expires_at=? WHERE item_id=? AND revision=? AND status IN ('PENDING','ACTIVE') AND wake_at<=? AND (lease_owner IS NULL OR lease_expires_at<=?) AND (status='ACTIVE' OR (SELECT COUNT(*) FROM autonomous_learning_items WHERE cycle_id=? AND status='ACTIVE')<?) AND EXISTS(SELECT 1 FROM autonomous_learning_cycles WHERE cycle_id=? AND status='RUNNING')`, token, iso(clock() + 300000), id, revision, now, now, c.cycleId, c.policy.limits.concurrency, c.cycleId);
        return changes(q) ? { cycle: c, item: await getItem(id) } : null;
    }
    async function reserve(c, i) {
        const command = nextCommand(i.document), kind = operationKind(command), id = 'alo_' + (await digest([i.itemId, command])).slice(0, 40);
        const existing = await first('SELECT * FROM autonomous_learning_operations WHERE operation_id=?', id);
        if (existing)
            return { operationId: id, kind, command: parse(existing.command_json), cached: existing.result_json ? parse(existing.result_json) : null };
        const limit = kind === 'RUN' ? c.policy.limits.maxRuns : kind === 'ANALYSIS' ? c.policy.limits.maxAnalysisOperations : 100000;
        const q = await run(`INSERT INTO autonomous_learning_operations(operation_id,cycle_id,item_id,kind,command_json,created_at)
   SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM autonomous_learning_operations WHERE cycle_id=? AND kind=?)<? AND EXISTS(SELECT 1 FROM autonomous_learning_items WHERE item_id=? AND lease_owner=? AND revision=?)`, id, c.cycleId, i.itemId, kind, canonical(command), iso(clock()), c.cycleId, kind, limit, i.itemId, i.leaseOwner, i.revision);
        if (!changes(q))
            failure(kind === 'RUN' ? 'AUTONOMOUS_RUN_BUDGET_EXHAUSTED' : 'AUTONOMOUS_OPERATION_BUDGET_EXHAUSTED');
        return { operationId: id, kind, command, cached: null };
    }
    async function grant(scope, { cycleId, itemId = null, operationId = null, leaseToken }) {
        const c = await getCycle(scope, cycleId);
        if (!c || !await live(c))
            failure('AUTONOMOUS_AUTHORIZATION_INACTIVE', 403);
        if (!itemId) {
            if (c.phase !== 'SNAPSHOT' || c.leaseOwner !== leaseToken || Date.parse(c.leaseExpiresAt) <= clock())
                failure('AUTONOMOUS_LEASE_INVALID', 403);
            return { cycle: c, policy: c.policy };
        }
        const i = await getItem(itemId), op = await first('SELECT * FROM autonomous_learning_operations WHERE operation_id=? AND item_id=? AND cycle_id=?', operationId, itemId, cycleId);
        if (!i || i.cycleId !== c.cycleId || i.leaseOwner !== leaseToken || Date.parse(i.leaseExpiresAt) <= clock() || !op || canonical(nextCommand(i.document)) !== op.command_json)
            failure('AUTONOMOUS_LEASE_INVALID', 403);
        return { cycle: c, policy: c.policy, item: i, operation: { operationId: op.operation_id, kind: op.kind, command: parse(op.command_json) } };
    }
    async function commit(i, op, result, update) {
        const now = iso(clock()), done = nextCommand(update.document).kind === 'DONE';
        const cycle = await getCycleAny(i.cycleId);
        const cache = op.kind !== 'READ' && result.status !== 'WAIT' ? canonical(result) : null;
        const qs = [db.prepare(`UPDATE autonomous_learning_operations SET result_json=COALESCE(?,result_json),completed_at=? WHERE operation_id=? AND EXISTS(SELECT 1 FROM autonomous_learning_items WHERE item_id=? AND lease_owner=? AND revision=?)`).bind(cache, now, op.operationId, i.itemId, i.leaseOwner, i.revision),
            db.prepare(`UPDATE autonomous_learning_items SET document_json=?,status=?,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,error_count=0,error_code=NULL,wake_at=?,updated_at=? WHERE item_id=? AND lease_owner=? AND revision=?`).bind(canonical(update.document), done ? 'DONE' : 'ACTIVE', iso(clock() + update.delaySeconds * 1000), now, i.itemId, i.leaseOwner, i.revision)];
        if (op.command.kind === 'PREPARE')
            qs.unshift(db.prepare(`UPDATE autonomous_learning_operations SET scenario_units=?,budget_valid=CASE WHEN ?+(SELECT COALESCE(SUM(scenario_units),0) FROM autonomous_learning_operations WHERE cycle_id=? AND operation_id<>?)<=? THEN 1 ELSE 0 END WHERE operation_id=? AND EXISTS(SELECT 1 FROM autonomous_learning_items WHERE item_id=? AND lease_owner=? AND revision=?)`).bind(update.document.scenarios.length, update.document.scenarios.length, i.cycleId, op.operationId, cycle.policy.limits.maxScenarios, op.operationId, i.itemId, i.leaseOwner, i.revision));
        let res;
        try {
            res = await db.batch(qs);
        }
        catch (e) {
            if (/budget_valid|CHECK constraint/i.test(String(e.message)))
                failure('AUTONOMOUS_SCENARIO_BUDGET_EXHAUSTED');
            throw e;
        }
        if (!changes(res.at(-1)))
            failure('AUTONOMOUS_LEASE_LOST', 409, true);
        return getItem(i.itemId);
    }
    async function finishItem(i, code, retryable = false) {
        const count = i.errorCount + 1, keep = retryable && count < 3;
        const document = structuredClone(i.document);
        if (!keep)
            for (const s of document.scenarios || [])
                if (!['VERIFIED', 'ALREADY_READY', 'PROTECTED', 'NEEDS_ATTENTION'].includes(s.status)) {
                    s.status = 'NEEDS_ATTENTION';
                    s.reasonCode = code;
                }
        const paused = `(SELECT status FROM autonomous_learning_cycles WHERE cycle_id=autonomous_learning_items.cycle_id)='PAUSED'`;
        await run(`UPDATE autonomous_learning_items SET document_json=CASE WHEN ${paused} THEN document_json ELSE ? END,status=CASE WHEN ${paused} THEN 'ACTIVE' ELSE ? END,error_code=CASE WHEN ${paused} THEN NULL ELSE ? END,error_count=CASE WHEN ${paused} THEN error_count ELSE ? END,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,wake_at=?,updated_at=? WHERE item_id=? AND lease_owner=? AND revision=?`, canonical(document), keep ? 'ACTIVE' : 'FAILED', code, count, iso(clock() + count * 10000), iso(clock()), i.itemId, i.leaseOwner, i.revision);
        return getItem(i.itemId);
    }
    async function finishCycle(id) { const c = await getCycleAny(id); if (!c || c.phase !== 'PROCESSING' || c.status !== 'RUNNING')
        return c; const list = await items(id); if (list.some(i => ['ACTIVE', 'PENDING'].includes(i.status)))
        return c; const counts = summarizeItems(list); await run("UPDATE autonomous_learning_cycles SET status=?,phase='DONE',updated_at=? WHERE cycle_id=? AND status='RUNNING'", counts.needsAttention || list.some(x => x.status === 'FAILED') ? 'COMPLETED_WITH_EXCEPTIONS' : 'COMPLETED', iso(clock()), id); return getCycleAny(id); }
    async function publicCycle(scope, id) { const c = await getCycle(scope, id); if (!c)
        failure('AUTONOMOUS_CYCLE_NOT_FOUND', 404); const list = await items(id); const ops = await all('SELECT kind,COUNT(*) AS n FROM autonomous_learning_operations WHERE cycle_id=? GROUP BY kind', id); return { contractVersion: CYCLE_CONTRACT, cycleId: c.cycleId, projectId: c.projectId, environmentId: c.environmentId, policyId: c.policyId, policyRevision: c.policyRevision, status: c.status, phase: c.phase, createdAt: c.createdAt, updatedAt: c.updatedAt, deadline: c.deadline, snapshotComplete: c.snapshotComplete, scopeBasis: 'CAPTURED_VERSION_REFERENCES', errorCode: c.errorCode, limits: c.policy.limits, usage: Object.fromEntries(ops.map(x => [x.kind, x.n])), summary: summarizeItems(list), items: list.map(i => ({ itemId: i.itemId, endpointId: i.endpointId, sourceVersionId: i.sourceVersionId, sourceVersion: i.sourceVersion, status: i.status, errorCode: i.errorCode, scenarios: i.document.scenarios })), executionStartedByThisRead: false }; }
    const listCycles = async (scope) => { const rows = await all('SELECT * FROM autonomous_learning_cycles WHERE organization_id=? AND project_id=? AND environment_id=? ORDER BY created_at DESC LIMIT 20', scope.organizationId, scope.projectId, scope.environmentId); return rows.map(r => ({ cycleId: r.cycle_id, status: r.status, phase: r.phase, createdAt: r.created_at, updatedAt: r.updated_at, environmentId: r.environment_id, policyRevision: r.policy_revision, errorCode: r.error_code })); };
    async function wakes() {
        const now = iso(clock());
        const cycles = (await all("SELECT * FROM autonomous_learning_cycles WHERE status IN ('RUNNING','PAUSED') ORDER BY COALESCE(last_enqueued_at,''),created_at LIMIT 100")).map(cycleRow), wake = [];
        for (const c of cycles) {
            if (!await settleInactive(c))
                continue;
            if (c.phase === 'SNAPSHOT') {
                if (c.wakeAt <= now && (!c.leaseOwner || c.leaseExpiresAt <= now))
                    wake.push({ cycleId: c.cycleId, revision: c.revision, itemId: null });
            }
            else {
                await finishCycle(c.cycleId);
                const due = await all("SELECT item_id,revision FROM autonomous_learning_items WHERE cycle_id=? AND status IN ('ACTIVE','PENDING') AND wake_at<=? AND (lease_owner IS NULL OR lease_expires_at<=?) AND (last_enqueued_at IS NULL OR last_enqueued_at<=?) ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END,wake_at LIMIT 20", c.cycleId, now, now, iso(clock() - 30000));
                for (const i of due)
                    wake.push({ cycleId: c.cycleId, itemId: i.item_id, revision: i.revision });
            }
        }
        return wake.slice(0, 100);
    }
    async function enqueued(w) { if (w.itemId)
        await run('UPDATE autonomous_learning_items SET last_enqueued_at=? WHERE item_id=? AND revision=?', iso(clock()), w.itemId, w.revision);
    else
        await run('UPDATE autonomous_learning_cycles SET last_enqueued_at=? WHERE cycle_id=? AND revision=?', iso(clock()), w.cycleId, w.revision); }
    return { policy, setPolicy, createCycle, getCycle, getCycleAny, getItem, items, control, claimCycle, commitSnapshot, snapshotError, claimItem, reserve, grant, commit, finishItem, finishCycle, publicCycle, listCycles, wakes, enqueued, settleInactive };
}
