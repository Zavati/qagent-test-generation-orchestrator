PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS test_design_generation_jobs (
  job_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('MISSING_TEST_DESIGNS', 'ALL_ENDPOINTS')),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED', 'CANCELLED')),
  endpoint_count INTEGER NOT NULL DEFAULT 0 CHECK (endpoint_count >= 0),
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  running_count INTEGER NOT NULL DEFAULT 0 CHECK (running_count >= 0),
  succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  catalog_endpoint_count INTEGER NOT NULL DEFAULT 0 CHECK (catalog_endpoint_count >= 0),
  existing_test_design_count INTEGER NOT NULL DEFAULT 0 CHECK (existing_test_design_count >= 0),
  eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  ineligible_count INTEGER NOT NULL DEFAULT 0 CHECK (ineligible_count >= 0),
  preflight_json TEXT NOT NULL DEFAULT '{}',
  max_attempts_per_endpoint INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts_per_endpoint BETWEEN 1 AND 10),
  max_concurrency INTEGER NOT NULL DEFAULT 3 CHECK (max_concurrency BETWEEN 1 AND 20),
  created_by TEXT,
  created_by_account_id TEXT,
  structural_error_code TEXT,
  structural_error_message_safe TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  last_updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_design_generation_job_items (
  job_item_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES test_design_generation_jobs(job_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  endpoint_method TEXT,
  endpoint_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'QUEUED', 'GENERATING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  generation_request_id TEXT NOT NULL,
  test_design_id TEXT,
  test_design_version_id TEXT,
  test_design_version INTEGER,
  error_code TEXT,
  error_message_safe TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  queued_at TEXT,
  started_at TEXT,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  UNIQUE (job_id, endpoint_id),
  UNIQUE (generation_request_id)
);

CREATE INDEX IF NOT EXISTS idx_td_generation_jobs_scope
  ON test_design_generation_jobs(organization_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_td_generation_jobs_status
  ON test_design_generation_jobs(organization_id, project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_td_generation_active_scope
  ON test_design_generation_jobs(organization_id, project_id, scope)
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_td_generation_items_job
  ON test_design_generation_job_items(job_id, status);
CREATE INDEX IF NOT EXISTS idx_td_generation_items_endpoint
  ON test_design_generation_job_items(organization_id, project_id, endpoint_id);
CREATE INDEX IF NOT EXISTS idx_td_generation_items_retry
  ON test_design_generation_job_items(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_td_generation_items_created
  ON test_design_generation_job_items(created_at);
