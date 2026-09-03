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
