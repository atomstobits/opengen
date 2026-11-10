# Execution engine

This package owns durable generation state and micro-USD accounting. REST and MCP should call the same engine instance; neither transport should implement its own reservation or submission logic.

```ts
const engine = createEngine({ databaseUrl: process.env.DATABASE_URL! });
await engine.initialize();
await engine.ensureWorkspace('local', 1_000_000); // operator bootstrap, idempotent
const job = await engine.submit({
  workspaceId: 'local',
  idempotencyKey: 'persist-this-before-submitting',
  input,
});
```

`ensureWorkspace` only credits a newly created workspace. It must never be exposed as an unauthenticated funding endpoint. All job reads and mutations require the caller's workspace ID.

## Worker and recovery

Run `workOnce()` in a separate process. It claims work with PostgreSQL row locks and a lease, persists intent before calling a provider, and polls at a 15-second default interval. The background queue is the durable job table; there is no second queue that can drift from the money transaction.

One user job currently has one provider attempt. Multi-route fallback is a later milestone. Completed jobs and route/deployment/price snapshots survive API and worker restarts.

A crashed or interrupted submission becomes `submission-unknown`; it is never automatically sent again. The reservation remains held until a trusted reconciliation establishes the result and billing. Polling failures preserve the provider task ID and resume polling. A queued job can be cancelled and released; cancellation after upstream submission is intentionally refused until a provider-specific cancellation contract is implemented.

## Settlement

Admission serializes on the workspace and reserves its quoted amount atomically with the job and ledger record. Reusing the same idempotency key and request returns the original job; changing that request conflicts.

Actual provider usage is translated with the snapshotted regional rate. Missing usage leaves `settledMicros: null` and the reservation held, even after an output arrives. A later trusted result carrying usage settles it exactly once. Provider charges above the reservation are recorded as an operator overrun; customer charges cannot exceed the reservation. The ledger records event amounts and separate available/reserved deltas, so a hold is not confused with a second charge.

`applyProviderResult` is an internal trusted boundary. Any external callback transport must verify the provider signature and task ownership before calling it. It is not an unauthenticated HTTP API.

## Alibaba adapter

The first real provider adapter supports Wan text-to-video and single-first-frame image-to-video. It follows the documented regional asynchronous submit/poll protocol. No live or paid generation was used to verify this bootstrap implementation; catalog status must remain `documented` until the operator performs a bounded smoke test.

Each real adapter exposes one pure preflight shared by route eligibility and submission. Unsupported references, frame counts, aspect ratios or operations are excluded before money is reserved; the adapter repeats the same preflight at execution in case a caller bypasses normal admission.

For Singapore, set:

```dotenv
ALIBABA_AP_SOUTHEAST_1_API_KEY=...
ALIBABA_AP_SOUTHEAST_1_WORKSPACE_ID=...
```

Other endpoint region codes use the same uppercase/underscore naming convention. Alternatively, the shared `DASHSCOPE_API_KEY` and `ALIBABA_WORKSPACE_ID` are accepted only when `ALIBABA_REGION` exactly matches the selected deployment's endpoint region. Region-scoped keys are never assumed interchangeable. Credentials are read server-side and are not stored in jobs, catalog responses or the ledger.

Reference/video-edit/extension operations with unqualified input-media charges are comparison-only. The worker does not call a provider for quotes or catalog reads. It does not support arbitrary upstream URLs. Output URLs retain provider expiry and are not yet copied into owned storage.

Protocol source: https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference

## BytePlus image adapter

The Singapore Seedream 5.0 Pro adapter executes synchronous text-to-image calls with `BYTEPLUS_API_KEY`. It requests one PNG at `1K`, `1.5K` or `2K` and returns an immediate result through the same durable job/attempt/accounting flow. It never fabricates a pollable task ID. Its 90-second HTTP deadline is shorter than the worker's default 120-second submission lease.

This first adapter intentionally rejects references, image editing and explicit `aspectRatio` instead of dropping them. Tier sizing lets Seedream choose image shape from the prompt; exact dimension mapping is a later capability. Actual returned dimensions establish the output pixel billing tier. Missing dimensions or inconsistent usage leave settlement pending rather than presenting the estimate as a settled charge. Upstream costs above the reservation remain operator overruns.

Synchronous network interruption can lose the response after generation has started. Such jobs remain `submission-unknown` with their credit held; resending would risk a second paid image, so no automatic retry is attempted. All adapter tests use injected HTTP fixtures and do not establish live-provider verification.

Protocol source: https://docs.byteplus.com/en/docs/modelark/image-generation-api

## Metrics

The seven-day metrics use recorded jobs, never seeded performance claims. Completion time is measured from gateway admission to receiving the provider's successful result URL; asset download time is not included yet. No samples produce null percentiles and null success rate. `failed` counts every failed job, while `unclassifiedFailures` identifies failures whose type is not known. Any unclassified failure withholds the technical success rate; when every failure is classified, policy/invalid-input failures are excluded from the technical denominator.

## Tests

Adapter tests replace `fetch`; they never contact a live provider. PostgreSQL invariant tests run only when `TEST_DATABASE_URL` points to an explicitly supplied test database. They use unique workspace IDs and do not truncate shared tables.

```sh
TEST_DATABASE_URL=postgresql://... npm test -- tests/engine.test.ts tests/engine-adapters.test.ts
```

For a development machine without a running PostgreSQL service, this wrapper starts an ephemeral loopback-only PGlite wire server, supplies the test URL, runs the same tests and shuts it down:

```sh
node packages/engine/scripts/test-pglite.mjs
```

PGlite checks SQL/transaction behavior and restartable engine instances in one local test process. Its connection multiplexer is not proof of native PostgreSQL lock/concurrency behavior; CI must also run these tests against a real PostgreSQL service.

Remaining milestones include provider fallback, remote cancellation, output persistence, workspace BYOK storage, signed outbound events and independently sampled production metrics. The package does not claim those features are complete.
