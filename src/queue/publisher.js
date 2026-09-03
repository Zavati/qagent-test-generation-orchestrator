import { OrchestratorError } from '../lib/errors.js';
import { buildJobItemMessage } from './contracts.js';
export async function publishJobItems(env, items, { chunkSize = 20, queue = null } = {}) {
  const target = queue || env?.TEST_DESIGN_GENERATION_QUEUE;
  if (!target || typeof target.send !== 'function') throw new OrchestratorError('JOB_QUEUE_PUBLISH_FAILED', 'Test Design Generation Queue is not configured.', { status: 503, retryable: true });
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize);
    try { await Promise.all(chunk.map((item) => target.send(buildJobItemMessage(item)))); }
    catch (error) { throw new OrchestratorError('JOB_QUEUE_PUBLISH_FAILED', 'Project generation job items could not be queued.', { status: 503, retryable: true, cause: error }); }
  }
}
