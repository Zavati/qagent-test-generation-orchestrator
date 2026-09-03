import { JOB_ITEM_CONTRACT_VERSION } from '../contracts/jobContracts.js';
export function buildJobItemMessage(item) {
  return {
    contractVersion: JOB_ITEM_CONTRACT_VERSION,
    jobId: item.jobId,
    jobItemId: item.jobItemId,
    organizationId: item.organizationId,
    projectId: item.projectId,
    endpointId: item.endpointId,
    attemptNumber: 1,
  };
}
export function validateJobItemMessage(value) {
  return Boolean(value && value.contractVersion === JOB_ITEM_CONTRACT_VERSION && typeof value.jobId === 'string' && typeof value.jobItemId === 'string' && typeof value.organizationId === 'string' && typeof value.projectId === 'string' && typeof value.endpointId === 'string');
}
