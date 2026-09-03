export function emitMetric(name, fields = {}) {
  console.log('qagent_test_generation_metric', { metric: name, ...fields });
}

export function durationMs(startIso, endIso) {
  const start = Date.parse(startIso || '');
  const end = Date.parse(endIso || '');
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}
