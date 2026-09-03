export const FOUNDATION_REVISION = '07.8-B';
export const JOB_CONTRACT_VERSION = 'qagent.project-test-design-generation-job.v1';
export const JOB_ITEM_CONTRACT_VERSION = 'qagent.project-test-design-generation-job-item.v1';
export const READ_CONTRACT_VERSION = 'qagent.project-test-design-generation-read.v1';
export const CREATE_CONTRACT_VERSION = 'qagent.project-test-design-generation-create.v1';

export const JOB_SCOPES = new Set(['MISSING_TEST_DESIGNS', 'ALL_ENDPOINTS']);
export const TERMINAL_JOB_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED', 'CANCELLED']);
export const TERMINAL_ITEM_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED']);

export const DEFAULT_MAX_ITEM_ATTEMPTS = 5;
export const DEFAULT_MAX_CONCURRENCY = 3;
