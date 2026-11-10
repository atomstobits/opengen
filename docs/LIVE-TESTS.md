# Bounded live provider verification

Live output is a release gate, separate from protocol fixtures. The current catalog and adapters are documented/fixture-backed, not automatically live-verified. The smoke tool uses the same REST quote, admission, jobs and ledger interfaces as clients; it never calls a provider directly.

The built-in smoke profile accepts an explicit budget of **at most $50 total**. The operator must authorize that spending; a CLI flag does not grant authorization. No paid calls were made while writing or testing this tool. Credentials are an external prerequisite and must stay outside source control.

## Prepare a private installation

Run the API, worker, PostgreSQL and private output storage using the installation instructions. Configure provider credentials on the API/worker, not in this script or browser. Use an OpenGen gateway key with both `read` and `generate` scopes; provide it privately through `MEDIA_ROUTER_TOKEN`. `MEDIA_ROUTER_URL` selects the gateway, or use `--server`. The tool permits HTTPS origins and localhost HTTP origins only; it refuses credentials, query strings and paths in that URL.

Use ignored, permission-restricted configuration or a secret manager for provider credentials. **Do not copy that configuration into examples, archives, logs or chat.** The smoke tool does not read provider key files; the operator loads the intended providers into the gateway runtime securely.

Use a private receipt **outside the repository**. Receipt files are mode `0600`; they contain exact synthetic inputs, private job/interaction IDs, stable idempotency keys, pricing evidence and budget accounting. They omit provider keys, gateway tokens, output URLs and private response bodies.

## Local proxy transport

When an installation already uses an approved HTTP proxy, configure its URL through `HTTP_PROXY` and `HTTPS_PROXY` in ignored, permission-restricted runtime configuration. Set `NO_PROXY=localhost,127.0.0.1,::1,[::1]` so local gateway and storage traffic stays local. Node does not automatically adopt macOS system proxy settings. [Node's `--use-env-proxy` option](https://nodejs.org/api/cli.html#--use-env-proxy), available from Node 22.21.0, reads these variables at startup. Local Node 22.23.2 accepted the option, reached the canonical provider hosts and passed an IPv4 loopback bypass check; it emitted an experimental proxy-agent warning.

For example, after loading the installation's other private runtime settings:

```sh
node --env-file=.env.transport.local --use-env-proxy --import tsx apps/server/src/index.ts
node --env-file=.env.transport.local --use-env-proxy --import tsx apps/server/src/worker.ts
```

This opt-in changes only the launched processes; it does not discover or change OS proxy, DNS or tunnel settings. Keep provider HTTPS hostnames, TLS certificate validation and header-based authentication intact. Output retrieval retains its bounded, DNS-pinned public-address checks and credential-host restrictions; proxy reachability of a provider API does not establish output-download reachability. Transport access does not qualify model pricing, generation entitlement or release evidence, and it does not change the shared test budget.

## Read-only plan

```sh
node --import tsx scripts/live-smoke.ts --server http://127.0.0.1:4310
```

Planning reads the catalog and submits quotes only. It does not create generation jobs or provider tasks. Each route is listed separately; all regions remain separate. A proposed request pins the exact route, disables fallback, uses one image or the shortest documented text-to-video duration, and selects the cheapest source-priced output configuration. The gateway must independently approve the exact operation and parameters.

Unknown prices, missing credentials/adapters, unsupported text generation and quote discrepancies are blocked. A provider family having an adapter does not establish live access, complete operation coverage or regional support. Reference/edit operations need a separate reviewed test fixture; the tool does not invent reference assets or substitute a different operation.

## Review the spending boundary

**A quote is an estimate, not a guaranteed upstream spending ceiling.** The gateway's `maxCostMicros` caps its admitted estimate/customer reservation; it cannot force a provider's eventual charge to match that estimate. The runner therefore refuses live execution unless the operator explicitly passes `--accept-estimate-risk` after reviewing the provider tariff and any provider-account controls. That flag acknowledges this limitation; it does not expand the approved $50 allowance or authorize an overrun.

For each case the runner holds the larger of twice the estimate or the estimate plus $0.01. This is a conservative test-budget hold, not a provider price formula or guarantee. Unknown-priced requests cannot execute. An actual charge larger than the hold is recorded from the ledger and stops further tests if the aggregate exceeds the budget. For a strict contractual ceiling, configure a provider-side enforceable spending limit or keep live testing blocked; the runner must not claim to create that limit.

Only one new route can be submitted per invocation. An earlier unresolved admission or unsettled charge blocks another test, even if local customer credits were released. The sole reviewed exception retains the full original hold for an already successful, delivered job with unknown billing, as described below; it never permits repeating that route. The budget is fixed in the receipt and bound to one gateway origin/workspace. A different gateway, workspace, budget, or nonempty legacy receipt is refused rather than starting a new accounting history.

## Execute one reviewed case

The command below is a pattern, **not an instruction to spend without the required review and authorization**:

```sh
node --import tsx scripts/live-smoke.ts \
  --server http://127.0.0.1:4310 \
  --execute \
  --route '<exact-ready-route-id-from-plan>' \
  --budget 50 \
  --receipt /absolute/private/opengen-live-test-budget.json \
  --accept-estimate-risk \
  --wait-ms 45000
```

The script atomically writes and fsyncs the receipt reservation and submission intent **before** its one billable HTTP request. An exclusive receipt lock prevents concurrent invocations from admitting extra tests. It persists the returned job and upstream IDs and polls existing jobs only. Waits are bounded to 60 seconds per invocation; run read-only resume for long video jobs.

An existing empty operator approval receipt can be used directly: the tool imports only the exact empty `{authorized_usd, spent_usd: 0, provider_requests: []}` form. It refuses to discard or reset recorded spending. Once converted, the versioned receipt is the accounting record for all subsequent tests.

### Extended journal observer authority

A shared journal can contain client-qualification entries owned by another gateway or workspace. Before any HTTP request, including session discovery, execution/resume/hold-acknowledgement reads the private receipt once under its existing exclusive lock. Present `clientQualification` origin metadata must identify a canonical gateway and workspace matching the journal's original top-level authority. Foreign or malformed origin metadata blocks the entire invocation, even for accepted, terminal or cost-reconciled entries; a different requested gateway is also rejected locally. Rejection preserves the receipt bytes, reservations and acknowledgements. Use the owning coordinator to observe extension entries; never rebind the original authority or make a copy into a new spending allowance.

## Resume and reconcile

```sh
node --import tsx scripts/live-smoke.ts \
  --server http://127.0.0.1:4310 \
  --resume \
  --budget 50 \
  --receipt /absolute/private/opengen-live-test-budget.json
```

Resume issues only reads. If admission's response was lost, the runner searches the current workspace's job listing for the exact unique synthetic prompt, model and pinned route. One match recovers the job ID. No match—or multiple matches—keeps admission unknown and its full budget hold. It never retries the generation POST, invents a new idempotency key, treats cancellation as a refund, or switches a region/provider to get a test through.

The native jobs endpoint lists the most recent 100 jobs. A very old admission may require operator reconciliation when it is no longer listed. A `reserved` entry means the process did not durably record submission intent; the automated resume still does not initiate paid work. Inspect process state and the gateway before changing any private receipt. A stale lock must be removed only after confirming its process is no longer running.

Budget accounting uses `details.upstreamCostMicros` from the job's settlement ledger entry. It deliberately ignores the capped local customer debit and BYOK's zero local charge. If the provider does not supply actual billing, the hold remains and further tests are blocked until operator reconciliation or the explicit reviewed retention below. A terminal generation is not automatically settled.

## Explicitly retain a reviewed unsettled billing hold

An operator may authorize continuing to a **different route** after reviewing a successful generation and its available, archived output, while leaving its actual charge unknown. This is an explicit opt-in for one exact job, not a billing waiver, settlement, refund, charge ceiling or new spending authorization. The original conservative reservation remains fully counted against the same aggregate budget. An unresolved submission, running/failed/cancelled generation, unavailable/failed/partial delivery or missing/invalid output hash cannot use this exception.

```sh
node --import tsx scripts/live-smoke.ts \
  --server http://127.0.0.1:4310 \
  --resume \
  --retain-billing-hold '<exact-existing-job-id>' \
  --budget 50 \
  --receipt /absolute/private/opengen-live-test-budget.json
```

This invocation makes no new generation request and must not include `--execute`, `--route`, `--wait-ms` or `--accept-estimate-risk`. Under the same exclusive receipt lock, the runner refreshes the owned job, requires accepted/succeeded generation with available delivery and all expected SHA-256 output hashes, and persists an acknowledgement bound to its exact job ID, request hash, full reservation and output hashes. It skips billing lookups for that acknowledged entry; actual cost stays `null`. The acknowledgement and future execution use the same receipt and lock. A later invocation may submit one different priced route only when every earlier unknown charge has its own valid acknowledgement and the retained holds plus the new reservation fit the unchanged budget.

Future admissions still refresh acknowledged jobs' generation/delivery state. Changed output hashes or unavailable delivery invalidate the exception; other unresolved admissions or unacknowledged charges continue to block. Duplicate-route checks remain in force. Acknowledged entries remain **pending** in automatic evidence and exit status until billing is independently reconciled; they never become passed or fully live-verified because their hold was retained. The normal execution example above is used for a subsequent different route; it does not repeat or replace the acknowledged generation.

## Release evidence

Review the exact private receipt and job result. A successful protocol submission alone does not establish a passed live release test. Require:

- Upstream generation succeeded on the exact intended model/deployment and input configuration.
- Output delivery succeeded, with the privately archived output's content hash recorded.
- Actual provider charge is settled/reconciled and total test spend remains within authorization.
- Errors, unsupported parameters, region/account restrictions and unknown billing are preserved truthfully.
- A human verifies that the media decodes and corresponds to the synthetic request; no quality benchmark or reliability percentage is inferred from one smoke sample.

Record a redacted dated result for the release commit in the provider coverage documentation. Do not commit raw receipts, signed output URLs, tokens, provider account IDs or generated assets without explicit redistribution rights. Failed, unresolved and untested routes must not be promoted to `live-verified`.

Execution/resume exits `0` only when all recorded tests have successful generation, available archived output hashes and known upstream costs. It exits `1` for a failed/cancelled generation, delivery failure or invocation error, and `2` for pending/unresolved evidence, no recorded tests or a reported budget overrun. A zero exit still requires the human media review above; no perceptual quality assertion is automated.

Remaining coverage gaps are listed in [providers/COVERAGE.md](providers/COVERAGE.md). The smoke planner cannot convert unqualified billing or an unimplemented operation into verified support.
