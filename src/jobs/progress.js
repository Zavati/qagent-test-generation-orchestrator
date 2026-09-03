import { READ_CONTRACT_VERSION } from '../contracts/jobContracts.js';

export function deriveJobStatus({ currentStatus, total, running, succeeded, failed, skipped = 0, cancelled = 0, retryWait = 0 }) {
  if (currentStatus === 'FAILED' || currentStatus === 'CANCELLED') return currentStatus;
  const terminal = succeeded + failed + skipped + cancelled;
  if (total > 0 && terminal === total) return failed > 0 ? 'COMPLETED_WITH_FAILURES' : 'COMPLETED';
  if (running > 0 || succeeded > 0 || failed > 0 || skipped > 0 || retryWait > 0) return 'RUNNING';
  return currentStatus || 'QUEUED';
}

export function toJobRead(job) {
  if (!job) return null;
  const terminalCount = job.succeededCount + job.failedCount + job.skippedCount;
  const progressPercent = job.endpointCount > 0 ? Math.min(100, Math.round((terminalCount / job.endpointCount) * 100)) : 0;
  return { contractVersion: READ_CONTRACT_VERSION, ...job, terminalCount, progressPercent };
}
