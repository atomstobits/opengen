# B1 verified cost and admission fee contract

2026-11-04. `packages/engine/src/billing-fees.ts` is a pure, fixture-backed
contract. It performs no I/O and changes no ledger, provider call, configuration,
spending limit or payment state. Main integration owns shared contracts,
`engine/index.ts`, numbered migrations and admission/settlement wiring. See
[BILLING-POLICY-PLAN.md](../BILLING-POLICY-PLAN.md), particularly section 11.

## Activation and unresolved decisions

`DEFAULT_FEE_POLICY` is disabled and exactly zero basis points. The proposed 5%
rate is `PROPOSED_SMART_FEE_BPS = 500`, usable only through an explicitly created
`activation: 'fixture'` policy. There is no production activation value or implicit
environment-variable switch in this module. A section 11 decision, disclosure,
reviewed activation change and separate operating authorization are still needed
before collecting a new fee from real customers.

An explicit fixture policy must name its ID/version, eligible generation/delivery
outcomes and `provider-first` cap allocation. Those are testable proposals, not
claims that the owner settled failure/cancellation/delivery/overrun policy. The
fixture examples use only `succeeded` as fee eligible; another fixture may
explicitly select other outcomes. Multiple billed attempts require review. Smart
BYOK remains gated regardless of configured rate.

## Exact arithmetic and public functions

All externally serialized money values are nonnegative integer microUSD bounded
by `Number.MAX_SAFE_INTEGER`. Arithmetic uses BigInt intermediates, checks its
result before converting back to a number and never multiplies floating point
money. Basis points are integers from 0 through 10,000.

`routingFeeMicros(cost, bps)` computes `ceil(cost × bps / 10000)` to one microUSD.
A zero cost produces zero fee. At 500 bps, USD1.00 (1,000,000 microUSD) produces
50,000 microUSD fee; one microUSD cost produces one microUSD fee. `addMicros`
rejects a total outside the safe range. `assertMicros` validates a money value.

| Export                                                   | Purpose                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `classifyRoutingService(selection)`                      | Classify the request/effective-policy service before admission.                        |
| `createFeePolicy(policy)`                                | Validate and independently deep-freeze an explicit policy.                             |
| `createFeeSnapshot(admission)`                           | Freeze policy, classification, billing mode and review deadline at admission.          |
| `legacyFeeSnapshot(billing)` / `LEGACY_FEE_SNAPSHOT`     | Describe existing zero-fee managed/BYOK work without retrospective repricing.          |
| `quoteGrossReservation(snapshot, estimate, ceiling?)`    | Compute provider estimate, fee estimate and gross reservation without side effects.    |
| `verifyProviderCostEvidence(evidence, expectedIdentity)` | Validate a supported USD evidence basis and exact attempt ownership.                   |
| `settleVerifiedCost(snapshot, settlement)`               | Produce an explicit settlement statement or held review result; does not mutate money. |

Objects and nested arrays returned from these helpers are deep-frozen independent
copies. JSON round trips preserve the admission snapshot and produce the same
calculation. No function reads the clock or current fee configuration, so delayed
settlement across a month cannot reprice a job. The transaction owner separately
retains the original accepted key-month UTC bucket and job idempotency identity.

## Service classification proposal

This module accepts a projection of routing controls: exact top-level `routeId`,
plus request and enforced policy `providerIds`, `deploymentIds`, `preference` and
`fallback`. Main must first run existing canonical validation,
`constrainRoutingPolicy`, exact-model exceptions, region/fidelity rules and
selected/fallback route authorization. This helper is not an authorization
replacement: its intersection alone does not reject every attempted policy
expansion and cannot resolve provider/deployment compatibility without the catalog.

The proposed classification is:

- An exact route, singleton effective deployment or singleton effective provider
  is direct when fallback is disabled; the smart fee is zero.
- An unpinned exact-model request selecting among providers/deployments is smart,
  even when the available candidate list happens to contain one item. Merely
  naming the model does not pin a serving provider. Candidate availability does
  not retroactively change the accepted service.
- Provider/deployment restrictions intersect; an empty intersection fails. A
  request cannot turn on fallback forbidden by policy. Explicit false narrows
  fallback-enabled policy.
- A pin together with effective fallback is rejected as contradictory before
  reservation. The API must ask for an explicit service choice rather than
  silently ignoring a pin or changing its fee. Pin plus a preference remains
  direct: the preference orders no alternative provider/deployment in this
  proposal, while exact compatibility remains mandatory.

Singleton policy restrictions count as a pin under this proposal. Whether a
provider pin still pays for regional selection, and how old clients disclose a
new service choice, remain section 11 decisions. Keep fee activation disabled
until the final shared API contract answers them. Use the same classification
projection at quote and admission; policy changes between them require a new
quote or a clear mismatch before a billable submit.

## Snapshot and reservation

```ts
const classification = classifyRoutingService({
  routeId: prepared.routeId,
  request: originalRequest.routing,
  policy: currentAuthoritativePolicy,
});
const snapshot = createFeeSnapshot({
  classification,
  billing: originalRequest.billing ?? 'managed',
  admittedAt: admittedAt.toISOString(),
  reviewDeadlineAt: approvedReviewDeadline.toISOString(),
  // Omit policy for DEFAULT_FEE_POLICY. Never use fixture activation in production.
});
const funding = quoteGrossReservation(snapshot, providerEstimateMicros, grossCap);
```

The caller supplies canonical UTC admission/review timestamps; the deadline must
follow admission and is frozen instead of moving forward on every retry. This
module deliberately invents no review timeout or automatic liability release.

For managed work, reserve `ceilFee(providerEstimate) + providerEstimate`; apply
request, key-month and workspace limits to that gross amount. For fallback,
compute the supported worst-case provider estimate across the permitted frozen
single-billed-attempt routes before calling this helper. No fee is compounded on
unbilled rejections or again when another fallback route is selected.

A null managed estimate is unavailable, not free. Direct BYOK reserves zero managed
credit even when its provider estimate is unknown. Smart BYOK returns
`byok-smart-not-qualified`; no provider base is charged twice. The pure contract
never authorizes a debit larger than both its reservation and accepted customer
ceiling; `quoteGrossReservation` therefore freezes a ceiling no larger than the
gross reservation. If the product later supports charging above an estimate up to
a larger customer cap, that requires an explicit funded-exposure design.

## Supported verified cost evidence

The expected identity is `{attemptId, providerId, deploymentId, upstreamReference}`
from the original stored attempt. Evidence must match every field and include a
bounded evidence reference. Supported bases are:

1. `provider-billed-usd`: an authenticated supported provider response reporting
   its actual USD bill as integer `amountMicros`.
2. `qualified-actual-usage`: `complete: true`, USD, reviewed `tariffId`,
   `tariffVersion`, `qualifiedAccountReference`, and complete actual usage lines.
   Each line uses integer `quantity`, `unitRateMicros`, and positive `ratePerUnits`.
   Lines are summed as exact rationals, then rounded upward once to one microUSD.
   Partial usage, an unqualified public price or missing account tariff is not an
   actual bill.
3. `operator-audited`: USD `amountMicros`, durable `auditReference` and authenticated
   `operatorId` from the existing audited reconciliation path.

The evidence producer must be trusted and reviewed. This pure validator cannot
prove provider signatures, account tariffs or operator authority; never map a
customer-supplied JSON object into these trusted inputs or label every existing
`billedCostMicros` adapter field verified. Provider qualification must establish
that the cost is a final bill or complete actual usage with the correct tariff.

Unsupported estimates/averages, missing or incomplete usage, foreign identity,
non-USD/invalid amounts and unqualified tariffs return unverified evidence. The
settlement result stays in review with the original held reservation and frozen
review deadline. A timer never proves non-acceptance or a zero upstream bill.
Verified zero-cost evidence may settle zero; unknown cost may not.

Only whitelisted cost/audit fields are copied to the statement. Raw provider
payloads, prompts, card data and arbitrary extra fields are discarded. References
are private application evidence, not public telemetry or external receipt links.

## Settlement statement and proposed cap allocation

```ts
const result = settleVerifiedCost(snapshot, {
  reservedMicros: originalReservation,
  customerCeilingMicros: acceptedGrossCeiling,
  evidence: qualifiedCostEvidence,
  expected: originalAttemptIdentity,
  outcome: finalGenerationAndDeliveryOutcome,
  billableAttemptCount: 1,
});
```

A settled result records currency, policy ID/version, frozen rate and service,
provider actual cost, customer provider debit, externally billed BYOK provider
cost, nominal/collected/waived fee, customer total, operator overrun, released
reservation, outcome eligibility and whitelisted evidence. A policy rate is never
presented as a fully collected fee when a cap caused a waiver.

For the explicit `provider-first` fixture rule:

1. `limit = min(reserved, accepted ceiling)` for managed work, zero for direct BYOK.
2. Collect provider base up to that limit.
3. Collect nominal eligible-outcome fee only from remaining room.
4. Record the remaining nominal fee as waived and uncovered managed provider base
   as operator overrun. Do not silently charge more or relabel provider cost.

At USD1.02 verified provider cost, a USD1.05 accepted limit collects USD0.03 of the
USD0.051 nominal fee and shows USD0.021 waived. At USD1.10 provider cost, that
limit collects USD1.05, shows USD0.055 fee waived and USD0.05 operator overrun.
For managed single-attempt work, exact conservation is:

`provider actual + nominal fee = customer total + waived fee + operator overrun`

`customer total + released reservation = original reservation`

For direct BYOK, actual provider cost is shown in `externalProviderCostMicros`;
OpenGen customer total, fee and operator overrun remain zero. Unknown BYOK cost
can return a review result with zero managed exposure, never a fabricated actual
cost. Root integration may keep the existing zero-debit BYOK settlement path while
tracking that unknown external provider bill separately.

## Required main integration hooks

- Add one nullable admission snapshot and a settlement-statement/evidence field in
  a centrally allocated forward migration. Null existing snapshots mean legacy
  zero fee, not the latest policy. Do not rewrite accepted inputs, hashes or old
  financial records. Keep the original UTC key-month bucket.
- Create the snapshot after authoritative policy/key/member revalidation and
  idempotent-job replay lookup, before reservation. Persist snapshot, gross
  reservation, accepted ceiling, original actor/key-month exposure and frozen
  provider pricing/attempt identity together under the existing locks.
- Use `quoteGrossReservation` for quote and authoritative admission. Plain GET,
  quote, schema and status calls have no financial mutation or recharge trigger.
- Adapter cost evidence qualification must be explicit. Until reviewed,
  nonlegacy smart-fee work must remain disabled/review; an old amount field or
  estimate is not automatically supported verified cost.
- Call settlement against the stored snapshot and original evidence/identity.
  Persist the statement, one customer settle debit, reservation release,
  original key-month correction and settlement outbox event in one replay-safe
  transaction. Keep separate provider/fee line items as ledger details or
  coordinated signed deltas; do not debit both the total and its fee component.
- Preserve existing legacy settlement behavior for null snapshots. Do not use a
  new policy to retroactively collect fees. Same-job polling/recovery/delivery
  never creates another fee or admitted generation.
- Review results retain held exposure, enqueue a private operator/customer-visible
  review item and preserve the fixed deadline. An audited operator liability
  absorption must be a distinct future resolution decision, not made-up zero
  provider evidence. No auto-release helper is provided here.

## Evidence

`tests/billing-fees.test.ts` covers 5%/tiny/zero values, BigInt boundaries, gross
cap checks, immutable policy changes, JSON replay/month-boundary stability,
request/policy intersections, contradictory fallback, disabled/default and
legacy/direct/BYOK behavior, supported and rejected cost evidence, exact rational
usage, outcome eligibility, waivers/overruns, unknown held liability, multiple
billed attempts and conservation. These pure tests do not establish database
atomicity, native races, provider tariff qualification or live billing readiness.
