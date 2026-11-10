# Execution observations and safe errors

The C6 execution module is fixture-backed. It provides observation normalization
for private workspace status reads; its presence does not establish provider,
server-route, deployment or client qualification. Shared adapter/worker wiring
and exported contracts are owned by the integration workstream.

`packages/engine/src/execution-telemetry.ts` extends the canonical `JobError` and
`JobProgress` types. Normalizers construct an explicit projection and discard
unexpected fields. They do not write financial records, create attempts or call
providers.

`JobError` uses closed gateway codes and messages. The category and recovery
action come from the code definition, not a provider's raw message. Known field
paths and explicit known provider code labels may be included. Arbitrary
syntactically valid codes, response bodies, exception text, URLs and credentials
are discarded. Unknown or legacy string errors remain absent from the compact
projection; existing legacy `Job.error` compatibility is a separate integration
choice. Provider code allowlists should be expanded only alongside qualified
adapter fixtures.

`retryable: true` means retry a read or recovery of the **same job**, according
to its recovery action. It never authorizes a paid submit. Submission uncertainty
requires operator reconciliation; a read failure never changes acceptance,
occupancy or charge state. Error messages do not promise cancellation, release
of money or refunds.

Progress requires an explicit phase, valid observation time and source. Missing
progress is null. A phase never implies a percentage, including completion.
Optional provider phase (`queued` or `processing`) and queue position survive
only provider-origin observations. Invalid or unavailable percentages and
positions become null. Queue position zero is valid evidence when explicitly
supplied; it is not a default.

Timings contain separate nullable queue, execution, delivery, end-to-end and
first-preview observations. Each present observation includes its duration,
source and observation time. Gateway execution is the measured span between
gateway-observed acceptance and provider completion; polling latency may be
included. It is not provider-reported inference runtime. A preview timing is
computed only from an actual preview observation, never from a running state,
percentage or completion. No image/video time-to-first-token metric is inferred.
Missing, reversed or invalid timestamps remain unknown. Observation timestamps
must include an explicit timezone.

## Integration recipe

The following additive hooks are proposals for the integration owner; this
package deliberately does not edit shared adapters or worker wiring.

1. Add optional `progress`, `structuredError` and `timings` observations to
   `ProviderResult`; initial accepted-submission observations may use the same
   shapes. Adapters populate them only from qualified fields and documented
   units. Preserve exact route and regional identity.
2. Persist `normalizeJobProgress`, `normalizeJobError` and `normalizeJobTimings`
   output in the execution JSONB columns of the job row. Update the revision's
   state timestamp atomically with each observation/result transition. Store no
   response bag. Nullable columns keep older rows explicitly unknown.
3. Map `SubmissionUnknown` to `jobError('submission_unknown')`, explicit
   submission rejection to `jobError('submission_rejected')`, and transient
   polling/read failures to `jobError('status_unavailable')`. Qualified terminal
   failure categories use `providerFailureError(result.failureCategory)`.
   Never classify by searching arbitrary exception/provider text.
4. Compact authenticated status uses the canonical `structuredError` field.
   It may include normalized observations without loading prompts, media
   capabilities, private receipts or full provider responses. Its revision must
   also change for delivery and settlement updates.

## Local evidence

On 2026-11-04, the focused `tests/execution-telemetry.test.ts` suite passed all
13 cases under Node.js 22. The fixtures exercise
private-data stripping, safe code/field allowlists, unknown legacy errors,
same-job retry semantics, unchanged financial source data, nullable progress,
provider/gateway distinction, invalid observations, measured timing spans and
explicit preview evidence. No network or paid provider calls ran. Combined
typecheck, native PostgreSQL races, browser checks and release qualification
remain integration-owner evidence.
