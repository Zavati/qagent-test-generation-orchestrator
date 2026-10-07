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

## 08.1.8 — Autonomous Learning Orchestration

This release keeps the generation job routes, queue and callbacks unchanged. A
separate `CONTROLLED_READS_V1` workflow coordinates existing Gateway, Evolution,
Registry, Runner and Results capabilities. It does not contain another AI or
readiness engine.

An owner/admin explicitly delegates supported confirmation and coverage changes
for one project/environment, exact runtime/auth origins, expiry and budgets.
Saving this policy does **not** start work. A separate idempotent cycle start
captures all source version references before Learning, collects compatible
proposals per source Test Design, applies one grouped version by signed policy
(not human approval), verifies linked reruns and reconciles effective maturity.
Unresolvable items become exceptions; successful items continue independently.
The current profile does not implement arbitrary request repair, new CRUD/data
preparation strategies, mutations or replacement of protected baselines.

Operational persistence is added by `migrations/0002_autonomous_learning.sql` in
the existing `TEST_GENERATION_DB`. It adds policy revisions, cycles, items and
idempotent operations; it never rewrites Test Designs, Results or prior jobs.

Provision the `qagent-autonomous-learning` queue before deployment. The producer
binding is `AUTONOMOUS_LEARNING_QUEUE`; the consumer has bounded batch/retries.
The minute cron recovers **already-authorized active cycles only**; it does not
create new cycles or continuously start Learning on new observations. HTTP calls
use the existing `TEST_DESIGN_GENERATION_SERVICE` and existing transport HMAC.
The new `AUTONOMOUS_LEARNING_HMAC_SECRET` is provisioned identically on Gateway,
Evolution and Registry for delegated application (not on this Orchestrator).
Never copy real secrets into ZIPs or source files.

One active cycle is allowed per project, including across environments. Pause
prevents new grants while preserving the slot and deadline. Resume is explicit.
Changing/revoking the policy, losing the delegator role or expiry stops subsequent
authorizations. Already-admitted calls may finish: pause/cancel is not rollback
of an HTTP request or an append already sent. Cached operation identities protect
recovery; they do not promise exactly-once network traffic or provider billing.

Progress is stored server-side. Closing the Console only ends UI polling. A
cycle has finite endpoint/scenario/run/analysis/time budgets and cannot turn an
unsupported proposal or a functional failure into success by weakening assertions.
Source versions are pinned; new externally-created versions are not silently
substituted during the cycle.

Local tests:

```sh
npm run test:f08-1-8
npm test
```

See the release handoff, validation report and smoke checklist for deployment
order, delegated authority, controlled-environment first run and limitations.
