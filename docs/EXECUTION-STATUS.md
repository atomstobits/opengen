# Private compact execution status

This package supplies `JobStatusStore` in `packages/engine/src/job-status.ts`.
The combined source registers `GET /v1/generations/{id}/status` and MCP `call` operation `jobs.status` with `{id,afterRevision?,waitMs?}`. These share the original transport for disconnects and fresh authorization. This is fixture evidence, not hosted activation or actual-client proof. Client/CLI adoption remains with onboarding.

`get(reauthorize, jobId)` returns an `ExecutionStatusView`, which extends the canonical `JobStatusView` with an opaque `revision` and nullable evidence-backed `timings`. `wait(reauthorize, jobId, { afterRevision, waitMs, signal })` returns `{ job, changed, timedOut }`. Without a revision, or if the revision already differs, it returns immediately. A matching revision may wait for changes to generation, delivery, settlement, structured errors, progress or timing evidence. A successful generation can still receive delivery and settlement updates.

The revision is a SHA-256 equality token over the safe projection, including normalized telemetry. It is not a monotonically increasing sequence or an event log: a transient change that returns to exactly the same state need not be observed. Historical status timestamps are preserved, and settlement changes invalidate the revision even if a legacy write did not update `updated_at`.

The query loads only selected status columns. It does not load input, prompts, outputs, signed URLs, upstream IDs, provider connection IDs, recovery receipts or complete job history, and never signs an asset. The projection uses the canonical `structuredError` field. Unrecognized legacy delivery evidence is `unverified`; absent progress and timings are `null`. Arbitrary legacy error strings are omitted from this compact projection. Attribution is not selected until the integration owner reconciles the governance schema; missing attribution must remain unknown.

## Authorization and server hooks

Pass a `reauthorize` callback that resolves the current API key, browser session or OAuth grant from the original request credential on every invocation. Do not close over a cached `Principal`. It must return the current workspace and scopes, or null if revoked/expired. The service checks `read` scope before querying and revalidates authority after each query and before a wait-timeout response. It pins the original workspace across the wait. A browser workspace change, removed membership, revoked key or revoked grant must fail the existing wait. The callback is responsible for current membership and OAuth-source-key checks.

The SELECT always includes `workspace_id=$1 AND id=$2`. Missing and foreign job IDs both produce `job_not_found` (404). Validate the UUID and bounded query parameters in the registered server operation. The registered HTTP operation is a compact sibling of `jobs.get`; `/v1/operations` and `/openapi.json` describe its arguments and response. Never implement status by calling a full job projection or signing its output URLs.

Set `Cache-Control: private, no-store` for every response, including errors. Add `Vary: Authorization, Cookie` and avoid public/shared response caching. An opaque revision must never bypass authentication or cause an unauthenticated 304. Register browser relay access explicitly through the existing allowlist.

Create an `AbortController` per transport wait. Abort it for request abortion and for a response close before `reply.raw.writableEnded`; a normal completed request-body close is not sufficient evidence of disconnect. Remove transport listeners in `finally`. An internal `status_wait_aborted` (499) means the transport is finished; do not attempt to send a new body to a closed socket. The same service is reusable for a future authenticated SSE transport, but SSE is not part of this slice.

## Limits and failure behavior

- Client wait is an integer from 0 through 25,000 milliseconds. Default is an immediate read. `afterRevision` is the prior 64-character lowercase hexadecimal token.
- Poll interval defaults to 500 ms; configurable bounds are 50–2,000 ms. There is no open transaction or retained connection between reads.
- At most 100 matching-revision waits run per service instance by default. `status_backpressure` (429) tells the caller to retry the same read. Immediate status reads remain available. This is a per-process waiting-memory guard; the HTTP service must also apply its ordinary request-rate/concurrency controls.
- Each snapshot observation (authorization, query and return-authorization together) is bounded to 5,000 ms by default; configuration permits 100–5,000 ms. A stuck read returns `status_read_timeout` (503), and late data is discarded. A disconnect ends the observation immediately. The final timeout-authorization check also has this bound, so transport timeouts must allow the wait plus this final check; a 31-second HTTP deadline covers the default maximum wait with a small scheduling allowance.
- The injected PostgreSQL pool must have `query_timeout`, `statement_timeout` and connection acquisition timeout no greater than 5,000 ms. The observation race ends the caller's wait; the driver/server timeout is required to free the underlying connection if a SELECT hangs. A late query cannot start follow-up authorization or return a snapshot after the observer is aborted.

Only SELECTs occur in this service. Wait timeout, disconnect, revocation and read backpressure never call provider submit/poll/cancel, claim a worker lease, release capacity, settle money, refund, regenerate or expire a queue-start deadline. A retryable status read authorizes another read of the same job only. Provider acceptance and billing remain unchanged.

## Integration and evidence

The unnumbered execution schema proposal supplies nullable `execution_progress`, `execution_error` and `execution_timings` JSONB columns on `mr_jobs`. The integration owner applies its allocated forward-only migration before enabling the status query. No old migration is changed by this feature.

`tests/job-status.test.ts` covers compact projection, no private fields, foreign/missing IDs, read scope, revocation during a query and wait, workspace switching, absent progress, unsafe money, delivery and late-settlement revisions, bounded wait/backpressure, disconnect during a timer or in-flight query, and stalled-read expiry with ignored late results. These are synthetic read-only fixtures, not hosted-client, native-PostgreSQL concurrency or live-provider proof.

Unexpected database/authorization exceptions are mapped to a closed `status_unavailable` error at the observation boundary. Driver messages, SQL details, URLs and credential text never become compact status errors. Explicit service authorization/not-found/deadline errors retain their safe codes.
