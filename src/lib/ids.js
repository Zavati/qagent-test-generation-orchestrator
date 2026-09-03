function cleanUuid(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '');
}
export function createJobId(randomUUID = () => crypto.randomUUID()) {
  const id = cleanUuid(randomUUID());
  if (id.length < 8) throw new Error('Could not create job id.');
  return `tdjob_${id}`;
}
export function createJobItemId(randomUUID = () => crypto.randomUUID()) {
  const id = cleanUuid(randomUUID());
  if (id.length < 8) throw new Error('Could not create job item id.');
  return `tdjobi_${id}`;
}
export function generationRequestIdForJobItem(jobItemId) {
  const normalized = String(jobItemId || '').trim();
  if (!/^tdjobi_[A-Za-z0-9_-]{8,120}$/.test(normalized)) throw new Error('Invalid job item id.');
  return `tdg_${normalized}`;
}
