-- UI-TD-2: additive operational state in the existing DB/queue. No API rows change.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ui_test_design_jobs (
  job_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  bundle_version_ids_json TEXT NOT NULL CHECK(json_valid(bundle_version_ids_json)),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','COMPLETED_WITH_FAILURES','FAILED','CANCELLING','CANCELLED')),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 50),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
  max_concurrency INTEGER NOT NULL CHECK(max_concurrency BETWEEN 1 AND 3),
  created_by TEXT,
  created_by_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  UNIQUE(organization_id,project_id,environment_id,operation_id)
);

CREATE TABLE IF NOT EXISTS ui_test_design_job_items (
  job_item_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES ui_test_design_jobs(job_id),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  bundle_version_id TEXT NOT NULL,
  generation_request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('PENDING','COMPILING','COMPILED','PUBLISHING','RETRY_WAIT','SUCCEEDED','NO_DESIGN','FAILED','CANCELLED')),
  stage TEXT NOT NULL CHECK(stage IN ('COMPILE','PUBLISH','DONE')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  compile_attempts INTEGER NOT NULL DEFAULT 0 CHECK(compile_attempts >= 0),
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK(publish_attempts >= 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  wake_at TEXT NOT NULL,
  last_dispatched_at TEXT,
  candidate_json TEXT CHECK(candidate_json IS NULL OR (json_valid(candidate_json) AND length(CAST(candidate_json AS BLOB))<=786432)),
  candidate_hash TEXT,
  specification_hash TEXT,
  candidate_saved_at TEXT,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
  publication_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(publication_uncertain IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(job_id,bundle_version_id),
  CHECK((candidate_json IS NULL AND candidate_hash IS NULL) OR (candidate_json IS NOT NULL AND candidate_hash IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ui_test_design_job_attempts (
  job_item_id TEXT NOT NULL REFERENCES ui_test_design_job_items(job_item_id),
  revision INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('COMPILE','PUBLISH')),
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','NO_DESIGN','RETRY_WAIT','FAILED','CANCELLED','LEASE_EXPIRED')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(job_item_id,revision)
);

CREATE INDEX IF NOT EXISTS ui_td_jobs_scope ON ui_test_design_jobs(organization_id,project_id,environment_id,created_at DESC,job_id DESC);
CREATE INDEX IF NOT EXISTS ui_td_items_job ON ui_test_design_job_items(job_id,job_item_id);
CREATE INDEX IF NOT EXISTS ui_td_items_wake ON ui_test_design_job_items(status,wake_at,lease_expires_at);
