# Customer prepaid credit

Updated 2026-11-06. Scoped manual prepaid credit is required for OpenGen's initial
release and still needs hosted sandbox and production acceptance. Configuration
does not enable live charges by default. Self-hosting and operator credits work
without Stripe. See [runtime integration 026](billing/runtime-integration-026.md)
for current startup, owner and production gates, and
[PAYMENTS-INTEGRATION.md](PAYMENTS-INTEGRATION.md) for the original wiring
and [PAYMENTS-UI-INTEGRATION.md](PAYMENTS-UI-INTEGRATION.md) for the dashboard slot.

## Behavior and boundaries

The approved human funding owner can initiate one-time USD top-ups from $5 to
$1,000, in whole cents. One cent is exactly 10,000 microUSD. The owner chooses when to pay;
OpenGen does not automatically recharge, subscribe, save a card for later charging
or collect card details. Hosted Stripe Checkout handles payment entry. OpenGen
sells its own service credit; Connect and a marketplace billing platform are not
needed. Scoped Checkout is funding-owner-only: the current browser membership
must match the approved funding owner, with billing permissions and the browser
recovery binding. Administrator status alone does not grant Checkout authority.
Delegated API keys and OAuth grants may perform only their separately permitted
operations, including generation within current workspace and spending limits;
they cannot act as the human funding owner or initiate Checkout. Installation
credentials cannot initiate payments either.

History returns the most recent 100 workspace orders. A local workspace-owned
order exists before Stripe is contacted. The client's
Idempotency-Key is unique within its workspace and cannot change amount. The
server generates/persists a separate Stripe key plus expiry and integration label
for the order. Concurrent preparation returns a retryable conflict. A network
failure retains the same order and request, even when Stripe might have accepted
it. Retry for at most twenty hours after first attempt, earlier than Stripe's
24-hour minimum idempotency retention; afterward the order needs operator review.
Never replace its key or issue a new Checkout request to guess the outcome. Keep
public origin, API version and Checkout request definition stable for outstanding
uncertain orders across deployments; changed parameters require reconciliation.

Only a signed webhook can credit. The success/cancel URL is a status hint and does
not change money. Even retrieving a paid session through the customer endpoint
does not credit it. Both completed and asynchronous-success events require paid,
complete state, USD, one-time payment mode, matching session ID, original local
reference, exact face-value subtotal/total, environment and payment identity.
Dynamic payment methods are enabled by omission of payment_method_types. Adaptive
pricing is disabled to keep USD face value fixed. No discounts or tax automation
are enabled. Tax treatment, registrations and customer terms require an explicit
operational decision before launch; absence of tax automation is no tax conclusion.

Delayed methods remain pending after Checkout completion while unpaid. Failure
and expiry never add credit. Paid success may arrive after stale failure; credit
remains exactly once. Duplicate/simultaneous events serialize by payment identity,
workspace and order. The ledger credit callback runs on the same transaction
client as payment/event state and any known risk hold, with no nested pool use.
The original ledger entry/reference is retained.

A webhook for an unknown session is journaled and returns 503 for retry. A signed
client_reference_id or metadata alone cannot claim an order. If a create response
was lost, the customer resumes the original stored order/key; only its returned
session ID can bind. If retries can no longer safely run, use Stripe request logs
and operator evidence, then an audited reconciliation change. Do not mint credit
from the redirect, bind arbitrary sessions by metadata, or fabricate a refund.

## Durable admission and request limits

Customer order creation admits at most **10 new orders per workspace per hour**
and **1,000 per installation per hour**. Actual customer-initiated Stripe Checkout
create/retrieve calls admit at most **30 per workspace per hour** and **3,000 per
installation per hour**. Windows align to UTC epoch hours. The gateway uses the
database clock, and a backwards clock adjustment cannot reset an active counter.
As fixed windows, these permit adjacent-window bursts around an hour boundary;
they do not promise sliding-window smoothing. These conservative source constants
and matching SQL constraints are deployment policy; changing them requires a reviewed code/migration change.

The database stores four counters/window values on each existing workspace row
and one singleton installation row. It creates no counter rows per key, order,
request or window and needs no cleanup queue or distributed rate-limit service.
The installation row is locked before the workspace row; both caps are checked
and incremented in the same transaction as local admission. Indexed primary-key
lookups enforce the caps across gateway processes and with a one-connection pool.
New order storage grows only at the admitted installation rate; historical orders,
payment references and financial records remain retained for reconciliation.

Existing client-key replay returns its original order without consuming order
quota, including when a cap has been reached. Authenticated order status/history
and webhook reconciliation consume no customer request quota. Webhook completion
must remain available while customer creation is limited. A known session is
returned from local state during a **60-second per-order cooldown**. Every later
customer-triggered retrieval, and every unknown-outcome create replay, consumes
both outbound quotas **before** an external call. Attempts that time out, fail,
crash or retry still count; no network result refunds or resets quota. The
persisted cooldown is separate from the request lease and survives response
binding, timeout handling, webhooks and process restarts.

A limited request returns `PaymentError` with status **429**, code
`payment_rate_limited`, a positive integer `retryAfterSeconds`, and explicit text
instructing the customer to wait and resume the same order/key. The shared server
error handler exposes the standard `Retry-After` header as documented in
PAYMENTS-INTEGRATION.md. Before the cooldown expires, a known session is cached;
an unknown result returns 429 without another Stripe request. After an hourly cap,
wait for the indicated window, then resume the existing order. Limiting never
changes amount, idempotency identity, original expiry, payment state or credit.
An order limited before its first external call remains unstarted and retryable;
an uncertain order retains the original twenty-hour safety cutoff and operator
reconciliation path. No limit restarts or replaces a billable request.

## Refunds, disputes and holds

Subscribe to charge.refunded, refund.created/updated/failed and all relevant
charge.dispute events. Each verified event creates a durable billing hold for the
known payment's workspace. Unmatched payment intents remain journaled/pending and
return 503. If they arrive before the local intent binding, binding/reconciliation
finds pending risk and imposes a hold before available credit is committed. Intent
advisory locks serialize this lookup with risk recording. A later dispute closure
or failed refund does not automatically clear earlier holds.

The main engine checks unresolved holds for new managed and BYOK generation
after acquiring the workspace row lock and before any new reservation/job. Existing idempotent jobs
remain retrievable; accepted jobs continue polling, settling or releasing funds.
The UI reports holds. No customer hold-clear, refund issuance, negative balance or
automatic ledger reversal is implemented.

Operators must monitor pending/rejected event rows, review Stripe's authoritative
payment/refund/dispute state, establish remaining unspent versus accepted-job
liability, and record a resolution reference before resolving each hold. Preserve
historical ledger entries and holds. Any financial adjustment needs an explicit,
audited policy and a separate ledger entry; operator credit is not a refund.
Stripe retries alone are insufficient operational monitoring: keep alerts for
unmatched/rejected events and orders in review, and retain delivery evidence for
manual recovery after the retry period.

## Server-only configuration

The example file [payments.env.example](payments.env.example) contains disabled
defaults and placeholders. Credentialed startup requires an explicit scoped
sandbox or manual binding; supplying test keys alone is rejected before database
initialization. The sandbox requires its separate database/origin and isolates
provider adapters. See [the binding and acceptance plan](billing/runtime-integration-026.md).
Inject secrets only into the API runtime, ideally through GCP Secret Manager with
access limited to this service identity. A restricted Stripe key should have only
Account read, Checkout create/retrieve permissions and necessary related read access;
verify actual permission names in the dedicated sandbox. No secret is a
NEXT_PUBLIC variable or frontend build input. Do not reuse another business's keys.
Webhook endpoint secrets are distinct from API keys and CLI listener secrets.

Use Stripe Node SDK **23.1.0** with API **2026-10-28.endive**. Both were verified
against official documentation and the installed SDK's esm/apiVersion.js, instead
of relying on the skill's older cached version. Pin the webhook endpoint event
version to the same snapshot API version; thin-event destinations are not handled.
Connected-account events are rejected; this is the operator's own payment account.
Registration receives explicit livemode:false for sandbox. Missing signing/API
configuration leaves a keyless installation without top-ups; partial credentialed
configuration requires the scoped binding and fails closed. Installations with
payments enabled must use a dedicated account/environment: unrelated unknown
Checkout/risk events intentionally remain pending for review rather than being
silently acknowledged as a completed payment.

Configure the canonical public origin (https://opengen.dev for hosted OpenGen),
using exact /billing return paths generated by the server. HTTP loopback is allowed
for local fixtures. For a publicly reachable self-hosted API, Stripe can post
directly to its TLS `/webhooks/stripe` endpoint. For the hosted private Cloud Run
API, configure Stripe's destination as `https://opengen.dev/webhooks/stripe`.
That dedicated Vercel POST relay preserves the original bytes (including BOM,
UTF-8 and whitespace) and Stripe-Signature, then adds a short-lived keyless GCP
service identity. It strips caller Authorization, cookies, Origin, workspace and
idempotency headers. The generic JSON/text proxy path must not be used for
webhooks. Stripe signing/API keys stay exclusively in GCP; GCP remains the sole
signature verifier and payment processor, including the SDK timestamp check.
The relay requires configured federation and a backend origin, bounds bodies at
1,000,000 bytes, follows no redirects and returns no-store responses. Missing
identity or unreachable backend returns 503 so delivery can retry. Account-scoped browser CSRF requires exact canonical Origin on POST; all
billing calls carry X-OpenGen-Workspace to protect against another-tab workspace
switches. The UI stores only a workspace-scoped retry record in localStorage, never
credentials, card data or a Checkout URL.

Subscribe at minimum to:

- checkout.session.completed
- checkout.session.async_payment_succeeded
- checkout.session.async_payment_failed
- checkout.session.expired
- charge.refunded
- refund.created, refund.updated, refund.failed
- charge.dispute.created, charge.dispute.updated, charge.dispute.closed,
  charge.dispute.funds_withdrawn, charge.dispute.funds_reinstated

## Validation and release work

Fixture-only command, serial and disposable PostgreSQL-wire PGlite:

```sh
node packages/engine/scripts/test-payments.mjs
```

This checks SQL constraints, isolation, timeout recovery, mismatched identity and
money, delayed/duplicate/out-of-order events, credit rollback, persistent risk
holds, exact raw signature verification, browser authorization and UI recovery.
Focused PaymentStore fixtures isolate the credit callback. The integrated core
uses the production `creditWorkspaceInTransaction` helper and spending-hold
admission guard, with shared-transaction rollback and replay coverage. The full
SQL runner includes the payment, cap and integration fixtures.

Run native races separately against a disposable PostgreSQL database (never prod):

```sh
TEST_NATIVE_POSTGRES=1 TEST_DATABASE_URL=<disposable-postgres-url> \
  node node_modules/vitest/vitest.mjs run --no-file-parallelism \
  tests/payments.test.ts tests/payment-rate-limits.test.ts tests/payment-concurrency.test.ts
```

Native races are explicit release gates: PGlite cannot prove cross-connection
lock semantics. The integrated PostgreSQL CI enables TEST_NATIVE_POSTGRES=1,
and the shared SQL runner includes payment/cap fixtures. The seven native-only
races remain unexecuted locally.

Source integration is complete: dependency/lockfile, production credit helper,
spending holds, durable caps/Retry-After, authenticated endpoints, UI and raw-byte
Vercel-to-GCP relay are wired. Whole-tree TypeScript is green; the earlier
isolated-branch shared-file migration errors are resolved. See
[VERIFICATION.md](VERIFICATION.md) for current integrated counts rather than
combining historical branch runs. Fixture checks do not establish Stripe account,
restricted-key, live signature-delivery or payment success.

Before release, verify dedicated Stripe sandbox Checkout (including delayed
success/failure), restricted-key permissions, webhook endpoint version/delivery,
failed delivery/retry, lost-response recovery, refund/dispute holds and operator
resolution, native PostgreSQL concurrency, desktop/phone cancel/reload/status UI,
and hosted proxy/Origin/auth wiring. Then complete explicit business/tax/customer
terms decisions, live secret rotation and permissions, and monitored live launch
approval. No sandbox account/session, live charge, tax registration, public release
or cloud deployment has been performed here.

## Official evidence reviewed

- [Stripe Directory](https://docs.stripe.com/directory): reviewed discovery/setup;
  CLI was unavailable; no account/provisioning or unrelated credential lookup ran.
- [Stripe Node SDK](https://github.com/stripe/stripe-node/blob/master/package.json)
  and [API versioning](https://docs.stripe.com/sdks/set-version).
- [Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create),
  [fulfillment](https://docs.stripe.com/checkout/fulfillment) and
  [dynamic payment methods](https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods).
- [Raw-byte webhook verification](https://docs.stripe.com/webhooks) and
  [idempotency/error recovery](https://docs.stripe.com/error-low-level).

The Stripe best-practices and documentation plugin skills were applied. Current
official docs/SDK were used where the cached skill version differed.
