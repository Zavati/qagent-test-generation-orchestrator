export function classifyProjectEndpoint(endpoint) {
  const endpointId = String(endpoint?.endpointId || '').trim();
  const method = String(endpoint?.method || '').trim().toUpperCase();
  const path = String(endpoint?.normalizedPath || endpoint?.path || '').trim();
  const lifecycle = String(endpoint?.lifecycleState || '').trim().toUpperCase();
  const classification = String(endpoint?.classification || '').trim().toUpperCase();
  if (!endpointId || !method || !path) return { classification: 'INSUFFICIENT_CONTEXT', reason: 'CATALOG_IDENTITY_INCOMPLETE' };
  if (lifecycle === 'IGNORED' || lifecycle === 'DEPRECATED') return { classification: 'UNSUPPORTED', reason: `LIFECYCLE_${lifecycle}` };
  if (classification === 'STATIC_ASSET') return { classification: 'UNSUPPORTED', reason: 'STATIC_ASSET' };
  return { classification: 'ELIGIBLE', reason: null };
}

export function preflightProjectEndpoints({ endpoints, existingEndpointIds, scope }) {
  const existing = existingEndpointIds instanceof Set ? existingEndpointIds : new Set(existingEndpointIds || []);
  const counts = { ELIGIBLE: 0, ALREADY_HAS_TEST_DESIGN: 0, INSUFFICIENT_CONTEXT: 0, CONFIGURATION_REQUIRED: 0, UNSUPPORTED: 0 };
  const eligible = [];
  const excluded = [];
  for (const endpoint of endpoints || []) {
    const endpointId = String(endpoint?.endpointId || '').trim();
    const hasDesign = endpointId && existing.has(endpointId);
    if (scope === 'MISSING_TEST_DESIGNS' && hasDesign) {
      counts.ALREADY_HAS_TEST_DESIGN += 1;
      excluded.push({ endpointId, classification: 'ALREADY_HAS_TEST_DESIGN', reason: null });
      continue;
    }
    const result = classifyProjectEndpoint(endpoint);
    counts[result.classification] += 1;
    if (result.classification === 'ELIGIBLE') eligible.push(endpoint);
    else excluded.push({ endpointId, ...result });
  }
  return { eligible, excluded, counts };
}
