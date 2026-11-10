# Mode-bound refunds and live funding source

Source implementation after core allocation of **030**, based on integrated main
`126aa54c02ea377d855bc07064015d07445ac156`. This is source qualification, not
financial, database, deployment, agreement, policy-publication or live activation
admission. All migrations **001–029 remain byte-identical**. Core owns identity
receipt029 and the separately assigned aged-cost remedy; this work adds no
competing identity, assent, paid-lot or liability-relief framework.

## Forward schema and closed mode gates

Migration030 drops only `mr_staff_refund_cases_livemode_check` and replaces
`mr_staff_refund_financial_guard`. Case, order, canonical ownership, registry,
normalized observation and private receipt must agree on the original
account/environment/mode/payment. Receipt and observation mode must be a real JSON
boolean; missing, string or opposite-mode values cannot qualify a money entry.
Original positive USD credit, exact debit/restoration, rounding, versions,
uniqueness, immutability, reservations and hold barriers remain. The existing
case/hold/expense functions are unchanged, and no old data is rewritten.

The store, raw-evidence producer and pinned existing-return controller require
explicit matching activation:

| Composition                        | Required original mode | Default behavior                                                              |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `fixture` or `sandbox` store       | false                  | No implicit activation; the producer/controller accept explicit sandbox only. |
| `manual` store/producer/controller | true                   | Explicit trusted composition and matching qualified processor namespace.      |
| Omitted or mixed activation        | none                   | Closed or rejected before a financial operation.                              |

False-mode version1 request/receipt fields, values, hashes and stable keys retain
their original meaning. Mode cannot be flipped on an existing case. Source
parameterization does not qualify any real account or grant credentials.

Every independent allocation phase reauthorizes the original transaction actor
before and after the awaited approval callback on the same client. The controller
also retains its per-client Domain-actor pin and processor assertions around
awaited hooks. Revocation or actor substitution rolls back; a subsequent new
transaction can use another legitimately authorized actor. Exact audited replay
skips new approval and money effects.

## Current human assent for new live funding

The runtime checks029 only for **new live manual funding**, after actual current
browser-human billing authority has been established. It matches the verified
issuer/subject, server-adopted policy version/digest, fixed notice/action/method
and current human owner on the financial transaction client. It rechecks policy
and authority after the awaited receipt read. Email, membership creation, a
customer flag, an API/OAuth grant, a draft receipt or another identity/version is
not current human assent.

`currentHumanTermsPolicy()` remains the real server default and remains draft.
This patch supplies no environment switch, effective date, publication or
agreement acceptance. Tests may inject an explicitly synthetic active-policy
reader; that is not adoption of the actual copy. Before real new funding, the
reviewed published/effective server snapshot and a genuine verified-human receipt
must agree. Separate purchase approval and billing-owner authority remain
necessary; Terms assent does not authorize a card charge.

The payment store derives `PaymentAuthorityContext.newFunding` from owned locked
state. A new order and the first never-started Checkout admission require the
current-assent check before counters, bindings or an outbound request. Existing
local-order idempotent reads, known Checkout sessions and original uncertain
accepted requests retain their frozen request/key and normal authority checks.
Recovery does not create another order or reinterpret an old serializer. The
original expiry/idempotency fences still require reconciliation instead of a blind
new paid retry.

The HTTP/UI summary keeps ordinary `enabled`/manual recovery eligibility separate
from `newFunding.allowed` and its fixed Terms reason. New-money controls can require
Terms while accepted/uncertain Resume remains available. An unstarted `created`
order still needs new-funding assent before its first Checkout. This metadata is
not authorization: the financial callback independently enforces admission. Reads,
verified fulfillment, accepted-job recovery and money actually owed in refunds do
not require accepting a later policy.

## Trusted refund workflow

The raw producer uses the official SDK over exact bytes, fixed300s delivery and
future-skew bounds, the configured own-account endpoint secret and an already
qualified account/environment assertion. It preserves signed event.created and
returns the original same-process seal. A genuine fresh redelivery can contain an
old event snapshot; authenticity is not unseen processor-latest state, unused paid
eligibility or bank receipt. Independently review current processor facts and
competing returns before financial phase approval.

Individual refund.created/updated/failed evidence is required. A historical
charge.refunded aggregate, callerJSON, type cast, serialized seal, edited timestamp
or locally re-signed payload cannot replace it. Account/context/mode and exact
original payment/refund/amount bindings remain mandatory. A later ingress
composition must preserve legacy risk receipts and cannot skip an authorized
known-case observation merely because legacy reconciliation reports a duplicate.
No new public endpoint is needed or supplied.

The existing-return controller remains unmounted and pins one original target.
Its rehearsal reports applyAllowed:false and writes nothing. Preparation consumes
the verified seal into origin=reconcile-existing and changes the snapshot, so
application needs fresh independent post-prepare approval. It supports only
explicit success adjustment and always resolves zero holds. It cannot issue or
dispatch a refund, initialize a namespace or become a generic hold resolver.

For initial new live returns, the domain now supports the matching manual mode
for prepare, one local dispatch claim, verified observation, exact debit,
definitively evidenced failure release/restoration and explicitly selected own
holds. A reviewed internal staff composition can use these existing phases before
a separately authorized human issues the exact cash amount in the Dashboard.
Unknown acceptance keeps the original attempt/identity and requires inspection
before any repetition. The application does not provide Dashboard idempotency.
No API issuer or broad runtime Refunds-write permission is necessary. Any later
issuer must have its own bounded original request, stable idempotency identity,
unknown-state recovery and separate operational admission.

Accepted jobs retain their original provider task, reservations and recovery;
refunds do not reset original key budgets. A charge aggregate, dispute or another
refund's hold remains separately reviewed. General relief for aged unknown
supplier cost belongs to core's separate assigned work; do not fake settle(0),
reject accepted work or relabel an operator credit as this refund.

## Required qualification and remaining operational inputs

Qualification covers explicit true-mode **local fixtures**, false-mode legacy
requests and receipts, mixed-mode/account/environment rejection, strict JSON
financial witnesses, original staff identity around awaits, paid principal/dust,
failed returns, same-key recovery and held/accepted work. A populated029→030
upgrade/restart must preserve every prior row and journal entry; native
PostgreSQL qualifies cross-mode/duplicate/admission races and matching-tool
backup/restore. Local/test-mode truth is not a real live payment or merchant proof.

The exact current source/check results and manual rehearsal plan are attached to
the private source PR. No actual initializer, migration or financial command is
provided for the protected namespace. Historical e458/727 receipts retain their
attribution; they are not relabelled as this source's hosted acceptance.

Root-reported merchant UI onboarding is complete, but qualified transport still
has to verify the actual account identity, trusted live key mode and
charges_enabled before a real binding. The selected account must not be confused
with the distinct sandbox or the APOB merchant. Company, business address and
current approved copy are settled; no new choices about them are requested here.

The separate live credential/webhook/GCP packet must pin the runtime source,
namespace/owner/schema, least-privilege live key, own-account endpoint/API version,
secret versions and readers, policy snapshot and rollback. Keep Checkout paused;
this source neither creates that key nor deploys those bindings. A dashboard's
additional active payment-method capabilities are not new method QA; normal
Dashboard-managed dynamic payment methods remain intentional and no
payment_method_types allowlist is introduced.

Policy publication/effectiveness, actual sign-in/assent, exact protected-resource
and financial admission, production binding/deployment and subsequent Checkout
opening remain separately reviewed actions. No new real charge/refund test,
provider call, credential/grant, image publication or budget follows from source
qualification.
