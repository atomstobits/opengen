# Existing refund controller

`apps/server/src/staff-refund-existing-controller.ts` is an internal, unmounted
controller for one already-issued refund in its explicitly matched namespace. It does not register an HTTP/MCP
route, read credentials from the environment, initialize a database, issue a refund
or claim a dispatch. It remains closed without explicit sandbox(false) or manual(true)
composition. Migrations001–029 are unchanged; allocated030 supplies mode-bound
financial guard support. This source does not activate a real live binding.

The constructor pins the original workspace, paid order, PaymentIntent, processor
environment/account, selected refund ID, original and returned cents, and exact
eligible microUSD. A known original charge can also be pinned. Request fields and
event metadata cannot redirect that target. The original credited manual order,
processor registry, canonical ownership and positive funding credit must already
agree. Missing legacy qualification is a stop condition, not permission to bind or
backfill the payment.

The trusted processor transport must already have passed its admitted account and
environment proof. Every controller operation reasserts that proof. The controller
also requires current installation-staff authority; mutation requires a separate
paid-allocation approval hook. Those callbacks must be supplied by reviewed server
composition, revalidate through the provided transaction client, and perform no
external I/O or independent wallet/funding writes under the store's locks. An
ordinary browser session, customer API key, self-hashed worksheet or operator JSON
is not an implementation of these approvals.

Allocation approval also revalidates staff on the same transaction client before
and after the awaited approval hook. Both checks must match the domain's captured
audit actor; a revoked or changed actor rolls back the phase. A later transaction
may use a different currently authorized actor. Exact audited replay still skips
the allocation hook and performs no new adjustment.

## Verified evidence

The producer uses the official SDK's static `Stripe.webhooks.constructEvent`
against the exact raw buffer and configured endpoint secret. It accepts no injected
verifier or already-parsed event. Delivery signatures have a fixed 300-second
freshness and future-skew bound; the original signed event creation time remains
unchanged. An old event can therefore be genuinely redelivered with a fresh Stripe
signature. A saved expired signature must not be made usable by disabling the
tolerance, changing timestamps or signing operator JSON.

Only individual `refund.created`, `refund.updated` or `refund.failed` snapshots can
produce the sealed individual evidence used by the store. The event must match
the canonical payment, configured mode and exact selected refund ID/amount.
Connected-account/context events are rejected. `charge.refunded` is aggregate
evidence and cannot establish an individual refund, even if a historical journal
records its object ID. Signature verification alone does not prove payer authority,
unused paid eligibility, bank receipt or permission to adjust the ledger.

A fresh delivery signature does not make an old event snapshot the processor's
latest state. Independent phase approval must also account for the currently
reviewed original refund, competing returns and any later known outcome. Without
that current review, stop at rehearsal/preparation/observation rather than applying
an older successful snapshot automatically.

Own-account Stripe events do not independently name their account. The endpoint
secret's association with the configured account/environment is trusted deployment
configuration, coupled to the independently verified transport and exact original
payment/refund identities. This source does not discover or change that association.

## Explicit phases

1. `review(context)` returns the existing staff-only financial evidence and
   snapshot after checking the pinned canonical payment.
2. `rehearse(delivery, context)` verifies an authentic raw delivery and returns a
   plain summary with `applyAllowed:false`. It stores no observation, case, hold,
   money entry or reusable verification seal. This still requires separately
   admitted access before any protected-database read.
3. After independent review of a current worksheet, `prepareExisting` verifies
   raw evidence anew and hands the original same-process seal to
   `StaffRefundStore.prepare` with fixed `origin='reconcile-existing'`. It creates
   the case/earmark/hold and observation only; it cannot dispatch or debit.
4. `observeExisting` accepts another authentic delivery for that exact case.
   Duplicate, delayed and contradictory evidence retain the domain's existing
   identity/order protection. Observations never apply a wallet adjustment.
5. `applyExisting` requires a fresh worksheet and independent phase approval.
   It invokes only explicit `apply-success`, optionally with a newly verified raw
   success reaffirmation. It always supplies `resolveHoldIds:[]`. A completed
   exact reference replay remains a domain no-op. Failed or pending outcomes do
   not become success because staff requests an adjustment.

Preparation and observation change the financial exposure hash. Review and approve
the post-prepare snapshot before applying; do not automatically approve a new hash
or reuse the preparation worksheet. Rehearsal summaries and serialized evidence
cannot be passed back as trusted proof. Raw bodies, signature headers and signing
secrets are not placed in financial/audit records or returned in the summary.

All original processor-risk holds and the new staff case hold remain unresolved
after this controller's debit. New admissions remain protected. Independently
reviewed per-hold closure, failed-return restoration, a new cash instruction and
any real live-mode activation are separate operational actions; this controller exposes none
of them. Accepted jobs, original funding credits, reservations and key budgets
retain the existing domain behavior.

## Qualification and remaining boundaries

Fixtures use real SDK-generated signatures over synthetic events and an isolated
test database. They prove source behavior, not that a saved production/sandbox
event has been verified. Native PostgreSQL separately qualifies transaction races.
No fixture authority, fake clock, synthetic secret or test database is a deployable
staff identity or an admission to touch the protected payment namespace.

The private existing-refund rehearsal plan pins the exact source/resources and
keeps execution disabled. It preserves historical source attribution and requires
separate reviewed admission for any real redelivery, database read/write or
controller invocation. No new charge, refund, key/grant, endpoint change, deployment
or live activation follows from this source.

See the [domain procedure](staff-refunds.md) and the
[mode-bound source and remaining operational boundary](staff-refund-live-source-plan.md).
Stripe's [signature verification](https://docs.stripe.com/webhooks#verify-signature)
and [delivery recovery](https://docs.stripe.com/events/manage-webhook-endpoints)
describe the underlying raw-body and resend requirements.
