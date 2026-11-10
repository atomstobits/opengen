# Billing decisions still required

Prepared 2026-11-04 against the fixture billing milestone. These are decision
requests and implementation examples, not recorded approvals. Source billing
functionality is independent of live activation. The existing provider smoke
budget does not authorize Stripe charges, mandates or new provider spending.

`DEFAULT_FEE_POLICY` remains disabled at zero basis points. New proposed 500-bps
policies are available only through explicit fixture configuration. Automatic
recharge and hosted payment setup are separately disabled by default. No migration
or new scope automatically appoints a funding owner, expands existing credentials
or creates an approved payment mandate.

## 1. Which routing service earns the proposed fee?

The fixture proposal treats an unpinned model request as smart provider/deployment
selection. A caller or effective policy pinning one exact route, one deployment or
one provider uses direct routing with no smart fee. Candidate count alone does not
change the service. A pin together with fallback is rejected before reservation;
there is no silent reinterpretation of either the route or the fee.

Examples requiring confirmation:

- “Use this exact regional route, with fallback off”: direct, zero routing fee.
- “Choose the cheapest compatible provider for this exact model”: smart, disclosed
  proposed fee before admission.
- “Use provider A but select its best region”: the fixture currently treats the
  provider pin as direct. Decide whether regional selection should be a distinct
  smart service before activation.
- An ordinary old client supplies only a model: decide the default and required
  pre-charge disclosure. Existing accepted jobs stay on their original zero-fee
  policy; a new operator configuration cannot reprice them.

The implementation intersects the routing projection with effective policy after
normal authorization/compatibility validation. It is not a substitute for exact
model exceptions, region/fidelity authorization or current key/member revalidation.

## 2. Which outcomes earn a routing fee?

A verified provider bill does not by itself decide whether a routing fee is owed.
The explicit fixture policy lists eligible outcomes. The primary example selects
only successful usable delivery. Other fixtures can test billed failure,
cancellation, partial delivery and unrecoverable delivery without making those
commercial choices live.

At USD1 verified provider cost and a proposed 5% rate, successful eligible delivery
has USD0.05 nominal fee. If the provider bills USD1 for a failed job, the base bill
remains visible; decide whether the fee is zero, USD0.05 or waived by an explicit
rule. A cancellation is neither proof of no bill nor a refund. Multiple billable
attempts stay under review until whole-job allocation is chosen; do not compound
a fee per attempt and again per job. Same-job polling, retrieval and delivery
recovery never create another fee or generation.

## 3. How does smart BYOK work?

Direct BYOK retains zero managed-credit debit. The customer pays its provider;
OpenGen must not charge the same provider base again. A smart-routing fee, if
chosen later, would be an OpenGen fee-only debit with a supported verified-cost
basis and explicit collection/funding behavior.

The current fixture contract gates smart BYOK and does not dispatch it as a paid
fee service. Choose which provider account tariffs/actual-usage reports qualify,
how fee-only exposure is reserved and what happens when the customer's provider
bill remains unknown. An estimate or public tariff without account qualification
is not actual cost.

## 4. Who absorbs a cap overrun, and when is unknown liability reviewed?

The fixture allocation collects the provider base first within both the original
reservation and accepted customer ceiling, then collects as much eligible fee as
fits. It explicitly records fee waivers and operator provider overrun.

For a USD1.05 accepted ceiling:

| Verified provider cost | Nominal 5% fee | Customer total | Collected fee | Waived fee | Operator provider overrun |
| ---------------------- | -------------- | -------------- | ------------- | ---------- | ------------------------- |
| USD1.00                | USD0.05        | USD1.05        | USD0.05       | USD0       | USD0                      |
| USD1.02                | USD0.051       | USD1.05        | USD0.03       | USD0.021   | USD0                      |
| USD1.10                | USD0.055       | USD1.05        | USD0          | USD0.055   | USD0.05                   |

Confirm this allocation before live fees. Do not label a partly waived fee as a
fully collected 5%. Do not increase the customer debit because a later actual bill
is higher than the amount funded at admission.

Unknown provider cost retains the held exposure and a fixed review deadline from
the original snapshot. The pure module invents no timeout or automatic release.
Choose the customer-visible deadline, operator queue/response process and audited
liability-absorption action. Time passing is not proof of non-acceptance or a zero
upstream bill. Late settlement corrects the original job/key UTC month; funding
never resets generation caps.

## 5. Who can authorize and delegate card funding?

The revised implementation boundary requires an explicitly approved funding owner
and envelope. An administrator role alone does not appoint that owner. Ordinary
read/generate keys, browser membership and OAuth grants do not gain billing scopes
from an enum change. Setup and mandate approval require the reviewed human owner
flow; an agent-supplied consent field does not create card authority.

The proposed narrow delegation lets an explicitly authorized agent manage policy
within that envelope, without workspace administration or an arbitrary charge
API. Both policy version and owner-authority version are compared at mutation.
Replacing/revoking authority or narrowing its envelope invalidates stale edits.
The worker rechecks the current policy, mandate, holds and limits before dispatch.
Accepted external payments still reconcile after disable/revocation.

Confirm which policy changes a delegated agent may make, which changes need the
funding owner's renewed approval and how the owner/envelope is initially approved.
No customer endpoint in this fixture milestone silently creates that approval.

## Private UI and API integration

`BillingPolicyPanel` is standalone and consumes authoritative capabilities. Mount
it with the browser's current workspace and recovery fingerprint, for example:

```tsx
<BillingPolicyPanel
  workspaceId={session.workspaceId}
  recoveryScope={session.recoveryScope}
  capabilities={summary.capabilities}
/>
```

`capabilities.read` gates private documents, funding attempts and policy; an
ordinary member sees only the limited wallet explanation and initiates no private
billing fetch. `manage` gates policy/portal actions. `setup` plus a non-null current
owner-authority version gates initial human setup. The backend must revalidate all
of these; props are presentation only. Existing manual top-up/history placement
must also adopt the new private capability boundary rather than continue exposing
funding history to every ordinary `read` member.

Every request carries both `X-OpenGen-Workspace` and the existing
`X-OpenGen-Recovery-Scope`. A scope/workspace/capability change remounts the panel
and abandons old replies. Every response includes its `workspaceId`; a mismatched
response is refused before display or navigation. No cookie or bearer credential
is written to browser storage. Setup recovery stores only a workspace-scoped
opaque client retry key, recovery fingerprint, terms version and consent reference before POST. Setup recovery is partitioned by workspace and identity/authority fingerprint. The authenticated POST response binds the original setup ID to the saved retry record.

Expected native response contracts:

- `GET /v1/billing/policy`: `{workspaceId,policy,automaticRechargeAvailable,
setupAvailable,terms:{version,text}|null,mandate:{id,status}|null,
ownerAuthorityVersion}`. `policy` includes `ownerAuthorityVersion` and its own
  optimistic `version`. Default activation flags are false and terms/mandate/
  owner authority are null until separately configured/approved.
- `PUT /v1/billing/policy`: `{expectedVersion,expectedAuthorityVersion,policy,
consentReference?}` → `{workspaceId,policy}`. A null authority version blocks
  editing. Enabling explains that future card charges may occur within limits.
- `POST /v1/billing/setup`: stable `Idempotency-Key` header and
  `{termsVersion,acceptedTerms:true}` → workspace-owned `SetupView`. The browser
  first displays the current server-owned terms and requires human approval.
  Server validates current human funding owner/terms, never agent-manufactured
  consent. A timeout resumes this same request; terminal stored completion or
  expiry allows clearing local recovery, not a return-URL flag.
- `GET /v1/billing/setups/:id` returns the stored setup view to the current authorized human funding owner, including while new setup is disabled. The fixed frontend proxy is `/api/billing/setups/:id`. A saved ID or hosted return parameter selects the read. Only the authenticated response establishes status, and only the matching terminal view can clear local recovery.
- `POST /v1/billing/portal`: `{}` → `{workspaceId,url}` with a reviewed Stripe
  portal configuration and current authority.
- `GET /v1/billing/documents?type=receipt|invoice&limit=20&before=...`:
  `{workspaceId,data,nextCursor}`. URLs are safe Stripe receipt/invoice/PDF
  links; no raw customer/payment object is returned.
- `POST /v1/billing/documents/sync` accepts `{type,limit:20,cursor?}` and returns
  `{workspaceId,hasMore,nextCursor}`. **Sync older** reuses that type’s Stripe cursor.
  **Load more documents** uses the independent cached list cursor.
- `GET /v1/billing/recharges`: `{workspaceId,data:RechargeAttempt[]}`. Unknown,
  authentication-needed and review states retain the original attempt reference;
  the UI does not expose a button to create another charge for recovery.
- `DELETE /v1/billing/mandate`: `{id:mandateId}` → `{workspaceId,...}`. Revoke current
  authority for new attempts while preserving accepted payment reconciliation.

New fixed frontend proxy files forward only these specific backend paths. Root
integration must register the native paths and preserve cookie,
Origin, idempotency, workspace/recovery headers and `Retry-After` in the existing
shared transport. No new generic URL proxy is provided. A 429 produces a bounded
wait and an explicit same-request retry; the client never automatically repeats
a financial mutation.

`BillingFeeBreakdown` optionally displays a persisted private settlement statement:
verified provider cost, collected routing fee, waived fee, operator overrun and
actual workspace-credit debit. It does not reprice a historical receipt. Receipt,
invoice, prepaid wallet credit and generation spending limits remain distinct.

## Evidence and remaining qualification

`tests/billing-policy-ui.test.ts` covers exact integer form conversion,
workspace/recovery fences, setup identity across reloads, foreign-workspace
rejection, paginated native envelopes, 429 retry identity and allowed hosted links.
Source and fixtures are not desktop/mobile browser acceptance, human mandate proof,
Stripe sandbox, native PostgreSQL races or live activation. Root integration must
run the serial browser/build checks against the finished candidate and preserve
separate operating approval gates.

## Original payment authentication recovery

When the approved funding owner sees `requires_authentication`, the explicit
**Authenticate this payment** action continues that original card PaymentIntent.
`recoveryAvailable` defaults false. Its authenticated POST is
`/v1/billing/recharges/:id/authentication`, with
`{expectedPolicyVersion,expectedAuthorityVersion}`. The server validates the
current funding owner, mandate, workspace, original payment/amount/environment and
current approved ceilings before returning a scoped client secret and public
Stripe key. Non-card methods stay in operator review; this is not a generic
charge or payment-method replacement operation.

The client validates workspace, attempt, amount and secret-to-PaymentIntent binding
before loading Stripe. Only the explicit enabled click loads official
`https://js.stripe.com/v3/`. It invokes `confirmCardPayment(clientSecret)` with
**no additional payment data**, using the existing attached method and original
amount. Stripe can show a hosted 3D Secure challenge dialog inside the page; this
is not a separate fully hosted payment page. This call form is documented in
[Stripe's current confirmCardPayment reference](https://docs.stripe.com/js/payment_intents/confirm_card_payment).
The installation must qualify its Stripe.js/CSP/frame behavior before activation.

The scoped secret lives only in the active function call; it is not written to
state, local/session storage, URLs, visible messages or logs. Raw Stripe error
objects/messages are not surfaced. Double clicks share one active attempt; a
workspace/authority switch before confirmation abandons it. A confirmed result
only prompts an authenticated status refresh. Wallet credit still requires the
original signed webhook and exactly-once ledger reconciliation.

`tests/billing-authentication-ui.test.ts` injects the authentication factory and
request transport, exercising original payment confirmation, duplicate clicks,
wrong identity/amount/secret/public-key rejection, disabled activation, stale
browser authority, processing/failed outcomes and secret-safe errors. These tests
load no external script and create no payment. Actual sandbox card authentication,
hosted challenge accessibility/CSP and signed webhook delivery remain separate
browser/Stripe qualification gates.

## Standalone installation-operator review

`apps/web/app/operator/billing-review.tsx` exports
`BillingReview({token,workspaceId?})` for later placement in the existing operator
surface. The parent supplies the installation token from memory; it is sent only
as an Authorization header and is not stored, rendered, logged or placed in a URL.
Changing authority/workspace remounts and clears the queue. Backend bootstrap
operator authorization remains mandatory. The existing operator page establishes a bootstrap session through an HttpOnly cookie, while this standalone component accepts an explicit in-memory bearer. A cookie-based mount needs its own operator-session request adapter and the backend’s operator and Origin checks. A bearer mount needs a caller that already holds the credential in memory. The HttpOnly session does not supply a bearer token to browser JavaScript.

The queue fetches only on an explicit manual refresh. Selected items show their
original reference, known workspace, amount/held exposure and state/reason.
Provider-cost items link to existing generation reconciliation; unknown Stripe
and manual-payment items explain how to inspect the original records without
another paid request. Risk-hold and automatic-payment resolutions require bounded
HTTPS evidence, a stable reference, verification notes and confirmation of the
specific displayed record/action. Resolution never creates a charge, generation,
refund or wallet credit. Clearing a hold may permit later spending/funding under
current policy; binding an original payment still leaves credit to verified
reconciliation.

Fixed proxies are `GET /api/operator/billing?workspaceId=...`,
`POST /api/operator/billing/holds/resolve` and
`POST /api/operator/billing/recharges/resolve`. Root integration owns native
allowlists, router mounting and placement in the existing operator panel. Stale,
rate-limited or uncertain requests are not automatically retried; a resolution
requires a refreshed inspection before another decision.

`tests/operator-billing-ui.test.ts` uses an isolated in-memory JSX build and static
render to verify there is no render-triggered fetch, token disclosure or implicit
signed-out authority. This is a privacy fixture, not interactive browser or
operator evidence acceptance.
