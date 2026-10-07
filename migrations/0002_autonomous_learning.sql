-- 08.1.8: operational state only. Existing generation / Test Design / Results unchanged.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS autonomous_learning_policies (
 policy_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), policy_hash TEXT NOT NULL,
 policy_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(policy_id,revision), UNIQUE(organization_id,project_id,environment_id,revision)
);
CREATE TABLE IF NOT EXISTS autonomous_learning_cycles (
 cycle_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
 policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL, policy_hash TEXT NOT NULL,
 policy_json TEXT NOT NULL, requested_by_user_id TEXT NOT NULL,
 request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('RUNNING','PAUSED','COMPLETED','COMPLETED_WITH_EXCEPTIONS','FAILED','CANCELLED','EXPIRED')),
 phase TEXT NOT NULL CHECK(phase IN ('SNAPSHOT','PROCESSING','DONE')),
 cursor_json TEXT, endpoint_count INTEGER NOT NULL DEFAULT 0, snapshot_complete INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT,
 error_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, wake_at TEXT NOT NULL, last_enqueued_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deadline TEXT NOT NULL,
 UNIQUE(organization_id,project_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomous_active_project
 ON autonomous_learning_cycles(organization_id,project_id) WHERE status IN ('RUNNING','PAUSED');
CREATE INDEX IF NOT EXISTS idx_autonomous_cycle_scope ON autonomous_learning_cycles(organization_id,project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS autonomous_learning_items (
 item_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES autonomous_learning_cycles(cycle_id),
 organization_id TEXT NOT NULL, project_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
 source_version_id TEXT NOT NULL, source_version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','DONE','FAILED')),
 document_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT, lease_expires_at TEXT, wake_at TEXT NOT NULL, last_enqueued_at TEXT,
 error_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(cycle_id,endpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_autonomous_items_cycle ON autonomous_learning_items(cycle_id,status,wake_at);
CREATE TABLE IF NOT EXISTS autonomous_learning_operations (
 operation_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES autonomous_learning_cycles(cycle_id),
 item_id TEXT NOT NULL REFERENCES autonomous_learning_items(item_id),
 kind TEXT NOT NULL CHECK(kind IN ('READ','RUN','ANALYSIS','APPLICATION')),
 command_json TEXT NOT NULL,
 scenario_units INTEGER NOT NULL DEFAULT 0,
 budget_valid INTEGER NOT NULL DEFAULT 1 CHECK (budget_valid=1), result_json TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_autonomous_operations_budget ON autonomous_learning_operations(cycle_id,kind);
