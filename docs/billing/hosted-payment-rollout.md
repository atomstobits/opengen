# Hosted payment rollout review

The initial OpenGen release requires a working payment flow. The proposed first
scope is manual USD top-ups for an approved funding owner using Stripe-hosted
Checkout. Stripe-confirmed funds add credit to the selected workspace once.
Existing caps, spending holds, history and recovery apply. Automatic recharge,
new setup, portal and commercial routing fees require their own scope and
qualification. Owner approval is required for launch limits, access and payment
terms. The current source bounds each top-up at USD 5 to USD 1,000.

## Candidate identity

Build the same reviewed source tree for the isolated sandbox and the proposed
production review. Record the main and billing recovery parents, resulting commit
and tree, CI run, API and worker image digests, Vercel deployment ID and staging
source, and migration journal checksums. A later change to a handler, serializer,
permission, transport or migration requires evidence for the new candidate.

The billing source appends 022–025 to 001–021; the current Playground integration
retains its comparison migration 026 after those immutable billing files. Migration 022 adds the fee and
cost state, 023 adds funding authority and policy, 024 adds processor and customer
records, and 025 adds recharge state, shared PaymentIntent ownership and risk
links. Preserve the existing 001–021 bytes, accepted and unknown work, balances,
orders, signing context, idempotency keys and checkout expiration times. A
historical request without a proven processor environment stays under review
until its original object or request can be established.

## Isolated sandbox preparation

Use a dedicated OpenGen Stripe sandbox, a separate Vercel origin and an IAM-private
Cloud Run API with a dedicated invoker. Use a disposable database and a verified
browser funding owner. The environment startup path reads the following
configuration before initialization:

| Configuration                                                                   | Required value or handling                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `OPENGEN_BILLING_SANDBOX` and `STRIPE_LIVEMODE`                                 | Explicit `true` and `false`, respectively.                                                                            |
| `OPENGEN_PUBLIC_URL`                                                            | Canonical sandbox HTTPS origin. The startup guard rejects the production origin.                                      |
| `DATABASE_URL`                                                                  | Dedicated `opengen_billing_sandbox` database or one with a lowercase suffix. Keep the URL in a pinned sandbox secret. |
| `OPENGEN_BILLING_PROCESSOR_ENVIRONMENT` and `OPENGEN_BILLING_PROCESSOR_ACCOUNT` | The registered environment ID and verified Stripe sandbox account ID. The pre-existing registry tuple has mode false. |
| `OPENGEN_BILLING_SANDBOX_WORKSPACE`                                             | The isolated workspace with current, explicit funding-owner approval for that environment.                            |
| `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`                                 | API-only pinned secret references for the restricted test key and the dedicated Stripe endpoint signing secret.       |
| `OPENGEN_BILLING_CHECKOUT`                                                      | `paused` by default. Set `open` only during the approved synthetic Checkout run.                                      |

Prepare the processor registry and explicit human approval through the reviewed
operator bootstrap. The service checks that approval under the workspace lock,
accounts for the outbound request in the durable quota, then verifies the Stripe
account. The same SDK and verified environment drive Checkout and reconciliation.
The sandbox mounts manual Checkout and fulfillment. Its explicit engine provider
execution gate is disabled, including BYOK reconstruction, frozen credentials,
submission, polling and upstream-media recovery. Empty adapter configuration
alone is not an isolation boundary. The setup, recharge, portal and
payment-authentication gates are closed. Use test data and test payment details
in all cases.

Set the nonsecret `OPENGEN_PROVIDER_EXECUTION_ENABLED=false` on both API and any
worker in the sandbox plan. Official entrypoints also force it off for sandbox
mode or the reserved `opengen_billing_sandbox` database namespace, so a worker
cannot restore provider access merely by omitting the control. Stripe credentials
remain API-only. Disabled generation/recovery workers stop before taking jobs or
receipt claims, retaining accepted/unknown work, reservations and retry state.
Owned-storage reads/signing, original-job lookups and Stripe reconciliation remain
available. Explicit local cancellation still requires proof that dispatch never
started; disabled execution does not imply a refund.

Use a separate Vercel configuration with `MEDIA_ROUTER_API_URL` pointing to the
sandbox API and the sandbox WIF provider and service account. Stripe needs a
reachable POST endpoint at the sandbox origin's `/webhooks/stripe`. The browser
surface uses application authentication and workspace recovery binding. Use a
sandbox ingress configuration that permits Stripe delivery without placing a
Vercel bypass credential or signing material in a URL. Direct Cloud Run ingress
requires the approved identity. The normal deployment script targets the regular
services. Review the separate sandbox service and Vercel plan before applying it.

## Sandbox acceptance and records

1. Start with the checkout gate paused. Verify source and artifact identity,
   private backend authorization, the exact candidate migration journal and a no-op second
   initialize. Record before-state order, event, ledger, balance, cap and hold
   counters for the synthetic workspace. The pinned e00b57c rehearsal has 025;
   a successor integrating Playground has 026 and requires its own qualification.
2. Open the sandbox gate and create one minimum top-up. Interrupt the client
   response and retry with the same persisted request identity. Check one local
   order, one bound Checkout session, matching Stripe account and USD amount, and
   no credit from a browser return. Confirm direct authorization denials.
3. Complete hosted test Checkout. Record Stripe's sandbox Workbench delivery ID,
   event type, version, mode, timestamp and response for the exact Vercel URL.
   Correlate with the GCP request and minimized event row. Verify one ledger row
   and exact microUSD delta. Resend the original event and compare ledger totals.
   A wrong, stale or modified signature must fail without financial mutation.
   Local Stripe CLI forwarding uses its own endpoint secret and is a separate
   fixture proof.
4. Use an eligible delayed test method. Observe the completed event with unpaid
   status, then the authoritative asynchronous success for that session. Check
   unchanged credit until paid, one credit on success, and no credit for failure.
   If the sandbox cannot produce both real deliveries, record the method gap.
5. Run same-order and concurrent retry cases and verify durable quotas and
   unchanged identity. Test a sandbox refund or dispute event, hold creation and
   refusal of new funding or spend. Match risk received before binding to the
   original payment and confirm accepted payment reconciliation continues.
6. Pause Checkout writes while an accepted delivery is pending. Check that new
   creates and Checkout requests are rejected, private history remains readable,
   and the signed delivery and replay finish through the original owner. Record
   operator triage for an unmatched or unrecoverable original object.

Record only identifiers, timestamps, bounded state, hashes and counts. Keep raw
body, signatures, Checkout URLs, credentials and card details out of reports.
The acceptance rules follow [Stripe's hosted fulfillment guide](https://docs.stripe.com/checkout/fulfillment),
[webhook verification](https://docs.stripe.com/webhooks) and
[idempotent requests](https://docs.stripe.com/api/idempotent_requests).

## Production review and rollback

The source now provides the separately guarded manual binding described in
[runtime integration 026](runtime-integration-026.md). It remains disabled by
default and unqualified for production. Require
explicit live mode, a verified merchant account and environment binding, a pinned
restricted live key and a distinct endpoint signing secret. The sandbox startup
path intentionally rejects live configuration. Review the exact production binding
and its tests before qualifying a live candidate. Agree funding-owner
admission, accepted payment methods, limits, fees, merchant terms, taxes,
refund and dispute operations, operator authority and incident ownership. The
proposed scope keeps the same Checkout serializer and payment ownership path.

Before the approved maintenance window, record a restorable backup and qualify
022–026 on an authorized scratch copy with the intended application role. Fence
old API and worker writers, including tagged routes. A no-traffic revision can
initialize its database, so confirm the fence before starting it. Preserve the
known-payment journal and unknown cases through migration. Verify application
and schema readback and the raw relay on the exact immutable candidate. Start
with admission paused and verify private reads, operator triage, identity and
existing delivery handling. Obtain a separate owner decision on opening approved
customer payment acceptance for that candidate. The release gate remains open
until this succeeds.

For an incident, pause new Checkout writes. Keep the current verified Stripe
webhook route, account binding, pinned secrets and billing-capable backend
available to drain accepted outcomes. Previously issued Checkout sessions can
still complete until expiration or separately approved cancellation. Inventory
open sessions and follow their original identity. Preserve pending receipts,
ledger credits, holds and caps. Roll back UI or general traffic only when the
webhook and existing status paths continue to reach the compatible backend.

Before migration or financial writes, a rollback can use the previously approved
image and bindings after checking traffic and schema state. After billing writes,
prefer a forward repair under paused admission. A destructive restore requires
reconciliation of all accepted Stripe outcomes and every post-backup ledger
change, plus the owner's separate approval. Keep migrations append-only.

Use [Stripe's go-live checklist](https://docs.stripe.com/get-started/checklist/go-live)
and [restricted key guidance](https://docs.stripe.com/keys-best-practices) when
reviewing the exact production bindings.
