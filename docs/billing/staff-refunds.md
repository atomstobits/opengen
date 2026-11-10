# Staff refund reconciliation

This is a staff procedure and a mode-bound domain implementation, not a
customer refund API or a live activation instruction. The store is closed by
default, requires explicit matching sandbox/manual mode and has no Stripe client. Neither this
document nor an operator credit adopts a commercial policy, creates a cash
return, or authorizes financial execution.

The separate [existing-refund controller](existing-refund-controller.md) supplies
the raw-signature producer and a fixed-target, explicitly mode-matched composition. Its rehearsal
is read-only; money still requires the independent approvals below. It remains
unmounted and cannot issue a refund or resolve any hold.

The deployed historical payment path records verified refund/dispute risk and
holds; it does not remove refunded wallet credit. A Dashboard refund followed by
clearing those holds is therefore unsafe. Use the complete reviewed case path,
including its paid-allocation approval, money receipt and final hold review.

## Ownership and authority

Use the original payment's processor account, environment, mode, paying workspace,
order, Session and PaymentIntent. Resolve its canonical ownership and original
`stripe-topup:<order>` credit. Never infer ownership from event metadata, a matching
amount, a current email address or the workspace's pooled available balance.

An authorized staff actor must verify the requester and original payer. Generate
permission, an agent grant and ordinary workspace administration do not authorize
redirecting cash. A closed workspace or changed membership requires staff review
of the original claim, not automatic forfeiture or a fabricated active membership.
Do not request full card/bank credentials, API keys, private tokens or generation
content in the support case.

The trusted staff-authority and paid-allocation approval hooks are mandatory for
money operations. Approval must bind the original payment, exact amount, worksheet
hash and current source snapshot. A self-hashed caller worksheet is not proof of
paid origin. There is no automatic paid-lot engine in this feature.

## Case sequence

1. **Intake and preserve the clock.** Assign one stable case/reference. Retain the
   original request time, requested amount, payment evidence and the applicable
   adopted policy/version. Keep processor-paid confirmation, local credit posting
   and support receipt times distinct. An unpaid Checkout's creation time does not
   start a paid-refund window; staff delay does not make a timely request late.
   Missing purchase IDs can be investigated without asking the customer to pay
   again. A pending policy draft is not an adopted customer agreement.

2. **Reconstruct and approve the paid remainder.** Obtain a complete, scoped
   financial snapshot, including funding references, all relevant ledger pages,
   paid/noncash provenance, prior cash returns, current reservations, attempts,
   submission intents, settlements/releases, holds and competing cases. Current
   customer order history is bounded and omits processor identities; a truncated
   history or the customer ledger alone is not the worksheet. Do not retarget a
   frozen sandbox collector as a production tool.

   Under the proposed V3 allocation rule, noncash already available at admission
   is allocated first, then paid purchases oldest first. Later grants do not
   retroactively replace paid use. Reservations retain their original allocation;
   a release restores the same origin and purchase date. Paid billing corrections
   remain linked to the original paid funding rather than silently becoming free
   promotional credit. Classify uncertain origins for review and separate any
   undisputed remainder.

3. **Secure before external action.** `StaffRefundStore.prepare` freezes the
   original identity, approval, versioned calculation and exact amount, and creates
   an independently identified staff hold. It earmarks the amount in the case;
   available and job-reserved wallet columns do not change at preparation. The
   workspace admission barrier prevents reuse. All concurrent case earmarks must
   collectively fit the available amount under the workspace money lock.

   Lock order is PaymentIntent advisory lock, workspace, original funding/ownership,
   case and then specific holds. Revalidate authority and the actual financial
   snapshot inside that transaction. A stale worksheet, insufficient eligible funds
   or unresolved identity/cash-return conflict must not become permission to send
   cash. A valid already-issued case with insufficient funds remains in review
   with a hold/outstanding liability; the wallet never goes negative.

4. **Claim one original-payment instruction.** For a new case, `dispatch` persists
   one immutable local attempt and marks external acceptance unknown; it makes no
   network call. Its stable identity is distinct from the purchase's Checkout key.
   A replay must not authorize a second submission. Staff then uses only the
   separately authorized processor operation for this original payment and frozen
   amount. No refund-issuance permission is added to the ordinary API runtime.

   A timeout, closed browser, missing response, pending or action-required result
   preserves the case/earmark. Inspect the original payment and existing refund
   before repeating anything. Dashboard clicks have no application-controlled
   Stripe idempotency guarantee. If a future API issuer is separately implemented,
   persist its own key/body and obey Stripe's retention window; never replay an
   unknown request indefinitely or replace it with a fresh key/case.

5. **Observe actual processor evidence.** The pure evidence normalizer accepts
   only the internal already-verified ingress contract and trusted account context.
   Its seal rejects plain JSON/clones; it is not cryptographic verification of an
   arbitrary staff assertion. `observeVerifiedProcessorEvidence` records the
   minimal matched evidence, not a cash operation or wallet adjustment.

   Identify actual returns by environment/refund ID and observations by event ID.
   `refund.created`, `refund.updated` and `charge.refunded` can describe one return;
   the Charge aggregate is not another individual refund. Missing identities,
   changed amount/currency/payment, contradictory or stale state and unaccounted
   bank reversals/disputes require review. A signature alone does not prove the
   remaining refundable amount or bank receipt.

   Preserve every previously approved return ID and amount. A registered case can
   account for an item omitted from a later worksheet only when its verified
   amounts agree with the retained history. Omission or a new approval cannot
   erase an amount conflict. Recheck that history before success, failed release
   or restoration; failure of one return does not resolve another return's review.

6. **Apply the separate money receipt once.** Only explicit staff reconciliation
   of the matched successful return can atomically decrease available balance by
   the exact approved microUSD, append its uniquely referenced refund ledger entry,
   record company rounding expense and finalize that case obligation. Never subtract
   the earmark twice. Original funding credits, order identity, job reservations,
   attempts and key-budget gross debits remain intact.

   Failed or canceled outcomes are not successes. A release or restoration requires
   a fresh current worksheet, trusted bound approval and definitive processor
   balance-return evidence. Ordering review also requires explicit sealed
   reaffirmation of the matching current failed/canceled outcome. Hard identity or
   amount conflicts remain held rather than being cleared by that decision. A
   restoration appends the opposite paid adjustment and expense offset once; it
   does not rewrite the debit or purchase. Late contradictory evidence must create
   review protection, not an automatic second debit, restoration or cash return.

   After a definitively failed return is released or restored, another matching
   failed observation with balance-return proof does not consume its principal
   again or reopen the completed case. Pending, successful or contradictory
   evidence still requires protection and review.

7. **Resolve only the reviewed holds.** Retain all evidence and recheck the current
   return, wallet receipt, earmarks, outstanding liability, accepted work and other
   holds. Resolve only individually identified appropriate holds. The staff-hold
   database guard prevents generic hold resolution before its money obligation is
   satisfied. The existing processor-risk hold resolver records actor/reference/
   note/evidence but does not itself prove a refund or debit. An unrelated dispute,
   unknown cost or later event remains in review. Processor success, application
   adjustment, bank receipt and case closure are separate facts.

## Rounding and original principal

For a new cash instruction, calculate separately for each original payment. Let `C` be its remaining
returnable principal in cents, excluding successful and still-possible pending/
unknown returns once. Let `R` be the staff-approved eligible, unreserved paid
microUSD attributable to that payment. Require:

```text
0 < R <= C * 10000
R <= that payment's eligible unreserved paid balance
sum(active earmarks) <= current wallet available
cashCents = ceil(R / 10000) <= C
companyRoundingExpenseMicros = cashCents * 10000 - R
0 <= companyRoundingExpenseMicros <= 9999
```

For `R = 4,993,456` and `C = 500`, return 500 cents, remove exactly 4,993,456
microUSD and record 6,544 microUSD of company expense. Do not debit 5,000,000 from
reserved or unrelated credit. If prior rounding/cash returns make attributed
credit exceed the remaining cash principal, reconcile that distinction and
preserve the other credit; do not hide it by capping the cash amount while debiting
all credit or recording a negative rounding expense. A different payment requires
its own original-payer route and case identity. Current purchase/refund fees are
zero; processor cost is not an undisclosed customer deduction.

A reconciliation-only case instead binds the actual return already made. Count
that refund ID once, exclude the matched return from **other** prior returns and
never treat it as another cash entitlement. It cannot dispatch. A mismatch between
that actual cash and the eligible credit adjustment remains review/outstanding
liability; do not inflate paid eligibility or take unrelated credit to force a fit.

## Accepted jobs and aged cost

The hold blocks new managed and BYOK admissions, including zero-wallet-reservation
BYOK. Already admitted queued jobs may still dispatch. Accepted or uncertain
attempts keep their original identity, credentials, recovery and reservations and
can settle or release under their original rules. For managed OpenGen wallet
charges, preserve the full accepted customer exposure, bounded by the accepted
reservation/cap; supplier overrun above that cap belongs to the operator. BYOK
direct provider bills are separate; a zero OpenGen reservation does not cap the
provider's own bill or establish refundability.

Do not infer zero cost from failure, a cancel request, a lease timeout, lost output
or a failed poll. Even a queued fallback can have predecessor attempts. Require
proof of never-submitted work or resolution of predecessor liabilities before
treating a cancellation/release as unused paid funds. Known late cost settles the
original job once. No replacement paid generation is part of refund recovery.

The proposed V3 aged-cost targets are manual: review at 24 hours, explanation
target within two business days, escalation at seven calendar days, weekly updates
and a documented decision by day 30. Core's [bounded aged-cost relief](aged-cost-relief.md)
provides an independently approved full-reservation advance while retaining the
original supplier unknown, key-budget hold and accepted-job recovery. Reliable
late settlement offsets only the unused advance from its original reservation
release. Its funding provenance and late receipt are included in staff refund
review evidence. Cash returns continue through the original-payment workflow.
Existing `reconcile` actions resume/reject/settle original jobs on evidence; fee
waiver/overrun fields retain their settlement meaning. The relief path has its own
default-closed staff composition and financial admission. Policy adoption and
actual operation qualification remain separate.

## Policy branches, processor limits and scope

If V3 is adopted, ordinary eligibility is the unused paid remainder requested
within 24 hours of successful paid confirmation, not a zero-use test. Closure,
qualifying material-change closure, billing errors and mandatory rights are
separate grounds. They do not eliminate original principal, payer or accepted-cost
revalidation. Staff targets are one business day to acknowledge, five to decide/
request specifics and two to initiate after approval/reconciliation; closure's
proposed target is 30 calendar days subject to earlier legal duties.

The possible 365-day expiry right is not a launch scheduler. Before any future
exercise it needs the adopted policy's applicability, reliable attribution,
30-day direct notice/use-or-return opportunity and audited adjustment. Reserved
funds are not silently expired, and a blocking hold requires the promised fresh
opportunity after resolution. No expiry action is enabled here.

Stripe normally returns to the original payment method; the Dashboard defaults to
a full refund, so an authorized partial return must use the approved amount.
Pending/action-required is not completion, and method/dispute interactions can
cause duplicate reimbursement. A failed original return may require a separately
verified lawful alternative; this module supplies no alternative-payout rail.
Do not substitute another card/bank or count a dispute and refund twice.
[Stripe refunds](https://docs.stripe.com/refunds)

Stripe API v1 POST replay protection lasts only while the key is retained (at
least 24 hours). Use the same frozen parameters within its safe window; unresolved
acceptance beyond it needs reconciliation, not another key. This module issues no
such POST. [Stripe error/idempotency guidance](https://docs.stripe.com/error-low-level#idempotency)

## Qualification and remaining boundaries

Migration 028 is a forward extension; 001–027 stay byte-identical. Staff holds have
their own typed identity, while real event uniqueness and existing resolution
foreign keys remain. New refund ledger/audit history must be immutable. The store
is not mounted into normal live startup and does not add a customer endpoint,
worker issuer, runtime Refunds permission or time-based financial rewrite.

Qualification must cover native admission/refund races, concurrent partial cases,
duplicates, lost responses, status reordering, identity/authority conflicts,
fractional amounts, failed-return restoration and a populated 027→028 upgrade.
Local PGlite is fixture coverage, not native concurrency or hosted qualification.

The already-issued sandbox card refund can be a later **reconciliation-only** case
bound to its existing refund ID. It never dispatches a new refund or retroactively
claims pre-refund security. Its exact code, CI, migration, case evidence and financial
admission must be reviewed first. Preserve the e458/727 receipts as historical;
any later adjustment needs a new before/after receipt. No sandbox financial
adjustment, real refund or policy adoption is authorized by these instructions.
