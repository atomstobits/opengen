# Durable automatic funding contract

2026-11-04. Source/fixture implementation only. New automatic charging, setup,
portal and on-session authentication capabilities default off independently. No
Stripe account, real payment, mandate or hosted activation was performed.

`RechargeStore` takes the existing pool, same-client credit primitive, shared
PaymentStore external quota callbacks, explicit activation gates and an optional
in-transaction funding/outbox callback. `admit(workspaceId)` is internal worker
logic; no HTTP/MCP charge endpoint exists. `workOnce(transport)` is periodic/event
work. Every policy/balance/status/history/schema GET remains side-effect free.

Admission locks the workspace and current policy/approved owner/envelope/mandate,
checks risk holds, available balance threshold, cooldown, failures, aggregate
amount and attempt caps, then persists a stable queued attempt. The original UTC
admission month, policy/version/owner authority snapshot, amount, mandate/customer/
method/environment, request serializer/API version and idempotency key survive
all retries. One relevant queued/submitting/unknown/processing/auth/review attempt
per workspace is enforced by a partial unique index as well as the workspace lock.

All non-cancelled admitted attempts count against that month's card-funding amount
and count caps, including declines. An active older-month uncertainty carries
exposure and blocks replacement attempts. This conservative fixture policy is
separate from generation key-month gross spending; card funding never resets job
reservations/debits or key caps. Source defaults and section11 decisions are not
real-charge approval. Threshold currently uses available (spendable) credit;
reserving a generation may therefore make a policy eligible for worker evaluation.

Dispatch takes installation quota before workspace/actor locks, rechecks current
policy version, owner approval/envelope, frozen mandate provenance, risk and queued
balance, and commits a durable external claim/cooldown plus quota before I/O.
Quota is never refunded after timeout/error. Each actual create/retrieve consumes
the same installation/workspace request budget as manual Checkout/setup. A policy
or mandate change cancels an unsubmitted queued attempt; an uncertain posted
attempt goes to review without another POST. Known accepted payments remain
reconcilable when policy/mandate/editor authority changes.

The saved card is charged only with the original amount/customer/method and
`confirm:true,off_session:true`. Unknown creation retains its key; retry stops
before20hours. No new key/object guesses acceptance. Known object recovery uses
GET. Direct responses bind identity/status only; only the existing raw-signature
verified webhook path can credit through `creditWorkspaceInTransaction` with
`stripe-recharge:<attemptId>`. PI, workspace, amount/currency/method/environment
and paid amount are checked. Duplicate/out-of-order/invoice events cannot credit
a second time. Credit, attempt/event state and funding outbox callback share one
transaction/client; pool size one is supported.

Risk events use the existing minimized payment journal and spending hold table.
A PI advisory lock serializes risk journaling with local binding. Even an unknown
risk event is journaled before that lock is released; binding discovers it before
credit. Automatic risk holds reference the recharge attempt; manual holds retain
their original order. Both block new generation/funding through the same workspace
hold guard. There is no automatic refund, reversal or timer-based hold clearing.

## Customer authentication of the original card payment

Authentication-required is paused, not a decline that can spawn another attempt.
The transport preserves the real PI status and a safe authentication-required
flag derived from authoritative Stripe evidence. For cards, an approved human
funding owner may explicitly request the original attempt's recovery capability.
The endpoint checks browser/session/recovery binding, current policy/envelope/
mandate and expected versions, frozen amount, pending exposure and risk both
before and after its quota-accounted Stripe GET. It returns a narrowly scoped
client capability with private/no-store; it is never stored in tables, browser
storage, audit logs or error messages.

The UI lazy-loads official Stripe.js only after an explicit gated click and uses
`confirmCardPayment(clientSecret)` without changing the attached method, amount or
PaymentIntent. Stripe hosts the3DS challenge. This is not a full hosted Checkout
page and is not a new arbitrary charge tool. Only the current browser funding
owner receives that capability; bearer/OAuth delegates cannot initiate it. A
successful browser confirmation only refreshes status; credit awaits the signed
webhook. Unsupported/non-card or detached methods remain under review. Actual
browser/CSP/SCA and dedicated sandbox validation remain release gates.

## Operator review

`BillingOperationsStore` supplies a bounded installation-only queue of unmatched/
rejected events, uncertain manual/automatic funding, provider-cost holds and risk
holds. Unknown event ownership stays null until authoritative binding; it is never
assigned from metadata. Queue reads neither charge nor settle. Funding delegates
cannot inspect or resolve it.

An operator may bind an original authoritative PI, or record confirmed-unpaid
provider evidence. Active external claims must finish first. A known PI must be
authoritatively cancelled before an unpaid resolution; age/note alone cannot
cancel processing/succeeded money. Binding never credits. Resolution references
include payment identity and reject changed evidence. A late response conflicting
with an unpaid decision creates a hold and retains the original attempt rather
than resurrecting it into another active charge. Risk-hold resolution records an
audited reference/note/HTTPS evidence and preserves its history and all ledger
entries; it does not issue a refund. Provider-cost unknowns require the separate
core fee-review/absorption path, never reservation-as-actual settlement.

## Integration seams and qualification

Core owns025 allocation/loader and shared factories. The unnumbered
`recharge-schema.sql` follows policy/customer fragments. Core should bind shared
credit and request-admission helpers and the existing private outbox, for example
`billing.settled` with `kind:'recharge'`, stable attempt key and credited amount;
no prompt/media/customer payload is needed. Reuse verified-recipient/member opt-in
notification delivery rather than emailing payment data directly.

Mount `registerBillingRoutes` and `registerBillingOperatorRoutes` through the core
auth projection; keep setup/delegation/enrollment/portal/SCA/operator actions out
of agent charge allowlists. The additive webhook dispatcher runs only AFTER the
existing exact-raw-byte signature/account/environment guard. Route setup/detach,
owned PI and risk to their stores; legacy manual serializer remains unchanged.
Document creation/sync and invoices never add wallet credit.

Domain SQL fixtures exercise actual shared credit, rollback, quotas, timeout,
owner/policy/mandate revocation, manual refill, cross-month uncertainty, duplicate
paid and risk events, SCA capability revalidation, and operator races. Native
multi-connection tests are gated TEST_NATIVE_POSTGRES=1. Main CI must run them and
a populated001–021 upgrade/dump/restore against022–025; local PGlite does not prove
native locks. Real bank, restricted-key, invoice/portal, relay and off-session/SCA
behavior remains unverified pending separately authorized sandbox/live gates.
