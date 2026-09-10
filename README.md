# qagent-test-generation-orchestrator — 07.8-B

Operational plane for asynchronous Project-level Test Design generation.

## Owns
- deterministic project endpoint snapshots;
- preflight/scope selection;
- one mutable job item per endpoint;
- Queue lifecycle, bounded retry/backoff and progress/history;
- D1 operational state.

## Does not own
AI prompts, provider calls, Test Data Planner, Semantic Guard, Secret-Safe Sanitizer, Observed Auth Bridge or Test Design contract validation. Each queue item calls the Gateway's existing mature generation use case through an internal Service Binding.

## Required bindings/secrets
- `TEST_GENERATION_DB` (D1, create `qagent-test-generation` and replace the placeholder database id in `wrangler.jsonc`)
- `TEST_DESIGN_GENERATION_QUEUE` (`qagent-test-design-generation`)
- `CATALOG_QUERY_SERVICE` -> `qagent-catalog`
- `TEST_REGISTRY_SERVICE` -> `qagent-test-registry`
- `TEST_DESIGN_GENERATION_SERVICE` -> `qagent-gateway`
- secret `CATALOG_QUERY_HMAC_SECRET` (same value used by Catalog/Gateway)
- secret `TEST_GENERATION_INTERNAL_HMAC_SECRET` (same value on Gateway and this worker)

## Deploy sequence
Create D1 + Queue, deploy this worker while Gateway already exists, then add/deploy the Gateway binding back to this service. Apply `0001_test_design_generation_jobs.sql` before creating jobs.

## Compatibility with 08.1.6 — Observed Baseline Generation & Provenance

The Orchestrator continues to delegate endpoint generation to the Gateway's
`/internal/v1/test-design-generation/endpoints/:endpointId/generate` route.
Baseline construction, feature gates, preservation and immutable Test Design
persistence belong to the Gateway/Registry. No raw baseline source or request
body is copied into job records.

This compatibility package corrects the D1 binding name to `TEST_GENERATION_DB`,
matching `src/persistence/jobRepository.js`. The database name and ID, queue,
secrets and runtime code are unchanged. No new migration is required.

- Enable the 08.1.6 flags on **Gateway**, not here; deploy compatible receivers first.
- `MISSING_TEST_DESIGNS` excludes any existing design, including legacy designs.
  To add observed baselines to an existing project after fresh monitoring, use
  `ALL_ENDPOINTS` or endpoint-specific regeneration. This creates new versions;
  it does not rewrite historical versions. Exploratory cases may be regenerated.
- Batch-created baseline policies default to `STRUCTURE`. Existing protected
  policies are preserved by Gateway/Registry. A new `CONTROLLED_STATE` approval
  or source replacement stays in the authenticated, endpoint-specific review UI.
- `SUCCEEDED` / `COMPLETED` describe generation/persistence, not test execution,
  READY status, baseline coverage, or complete AI exploration. Inspect the
  referenced Test Design/inventory for those details.
- Drain existing jobs before rollout/flag changes. The endpoint list is
  snapshotted at job creation, but source selection and feature gates are
  evaluated when each endpoint is processed, not frozen for the entire job.
- Retries reuse `generationRequestId`, protecting Registry version persistence;
  an ambiguous failure after a commit can still repeat generation/AI work.

Local checks (no production access):

```bash
npm run test:f08-1-6
npm run check:08.1.6
```

The integration audit also tests Orchestrator → signed Gateway handler → real
08.1.6 generation/persistence → Registry over local SQLite, with controlled
Catalog/context/provider and queue transport. It is not a Cloudflare deploy or
live pilot smoke. See the accompanying audit/validation package.
