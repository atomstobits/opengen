# Billing runtime integration after comparison 026

This source combines the reviewed billing runtime with the current Playground
admission path. Billing migrations 022–025 retain their original bytes and
checksums; private comparison stays in 026. The billing runtime, routes and UI
belong in the initial-release source archive. A source merge does not activate
hosted payments or establish Stripe acceptance.

Single jobs and both comparison children use shared preparation and admission.
Current authority, billing holds, wallet credit and key exposure are checked
inside the admission transaction. A rejected second child rolls back both
children. Explicit fee acceptance records the gross reservation and original
policy snapshot for a single job. Comparisons keep their existing provider-cost
quotes and do not accept or silently add commercial fees. Fee-bearing comparison
quotes are outside this implementation.

Private output slots, receipt recovery and owned reuse retain the Playground
implementation. Billing summaries add fee evidence without replacing those
delivery fields. Settlement uses the existing transaction client to read the
original credential identity, including with a one-connection pool.

The browser preserves the opaque fragment on a verified Stripe Checkout URL.
HTTPS, exact `checkout.stripe.com` authority and `/c/pay/<id>` remain required.
Other billing destinations keep their existing fragment restrictions.

## Payment-only sandbox execution boundary

The sandbox disables the engine's provider execution gate, independently of the
adapter list. It blocks managed and BYOK admission, reconstruction of stored or
frozen provider credentials, provider submit/poll and upstream-media download or
refresh. Worker and delivery recovery stop before claims or retry changes;
queued, accepted and unknown jobs retain their original IDs and money state.
Exact admitted request replays and ordinary job/owned-output reads remain usable.
Explicit cancellation of a proven never-dispatched queued job remains local;
started work does not gain an assumed cancellation or refund.

`OPENGEN_PROVIDER_EXECUTION_ENABLED` is an exact nonsecret true/false control
shared by the official API and worker, defaulting to true for normal/live manual
operation. Set false in the sandbox plan. Sandbox mode and the reserved sandbox
database namespace independently force it off even if a worker omits or enables
the control. Stripe keys and other billing authority remain API-only. This pauses
generation/provider I/O, not Stripe test Checkout, fulfillment or billing reads.

## Production manual binding

The source provides a separate manual live binding with disabled defaults. It
is not enabled by the example environment. It requires all of the following:

- `OPENGEN_BILLING_MANUAL=true`, `STRIPE_LIVEMODE=true`, the canonical
  `https://opengen.dev` origin and a valid configured database. Sandbox and
  manual activation cannot be selected together.
- A restricted live API key and a distinct webhook signing secret supplied only
  through reviewed, pinned backend secret versions. Live keys alone cannot
  activate the legacy unscoped startup path. Test credentials also require an
  explicit scoped sandbox; they cannot fund normal provider adapters through
  unscoped startup. Keyless self-hosting remains supported.
- A pre-existing processor registry entry with the exact account and live mode,
  plus a current approved funding owner in `OPENGEN_BILLING_MANUAL_WORKSPACE`.
  The configured approval reference must match that owner's stored approval.
- Explicit approved terms version and text. This source does not invent merchant
  terms. The single quota-admitted account read must match the registered
  account and confirm that charges are enabled.

`OPENGEN_BILLING_CHECKOUT` defaults to `paused`. This rejects new orders and
Checkout creation while retaining authorized history and original signed
payment reconciliation. Manual mode keeps setup, saved-method charging,
automatic recharge, portal creation and authentication recovery closed. The
normal worker does not acquire an automatic-recharge dispatch path. Commercial
generation fees still require their separately approved policy and cost proof.

Operator billing triage is closed unless a separately approved dedicated
`OPENGEN_BILLING_OPERATOR_BEARER` is supplied to the backend. It must be distinct
from Stripe credentials and the general API token. Empty configuration grants
no operator access. Review its pinned secret, holders, rotation and incident
authority before customer admission; this source integration creates no token
or production grant.

The live startup does not create a funding workspace, seed a balance, register
an account, enroll an owner or approve terms. Existing legacy live deployments
must migrate to the reviewed registry and owner binding; they cannot fall back
to the unscoped live writer. Fence all older API and worker writers before any
new revision initializes the database, even when Checkout admission is paused.

## Manual testing plan and remaining gates

1. Run typecheck, catalog validation, formatting, release hygiene and the native
   PostgreSQL suite on the exact integration head. Run the populated upgrade,
   repeated initialization and dump/restore harness through 026. Preserve
   wallet, ledger, unknown work, legacy orders, holds, keys and migration history.
2. Run desktop and phone billing browser tests. Check identity/workspace changes,
   session-only billing access, durable order recovery, one create after retry,
   holds and admission pause. Exercise a real-shaped fragment-bearing Checkout
   link through the browser redirect while intercepting external requests.
3. Complete owner-approved sandbox key and webhook setup, then deploy the exact
   sandbox candidate under paused admission. Verify account/mode/environment,
   owner, source/image and migration identities. Use hosted test Checkout, an
   actual unpaid-to-asynchronous outcome when the method supports it, and a
   Stripe-signed resend of the original event. Compare one order, one credit and
   unchanged balance after replay. See [hosted rollout](hosted-payment-rollout.md).
4. Review the live merchant account's readiness, restricted permissions, distinct
   endpoint, approved owner/terms, launch amounts, accepted methods, taxes,
   refunds/disputes and incident ownership. Provisioning or reading live keys
   and changing production bindings require their separate authorization.
5. Rehearse backup, writer fencing, upgrade and restore on an authorized scratch
   copy. Review exact secret versions, identity grants, source/image, live
   registry and owner approval. Start the separately approved production
   candidate with Checkout paused; verify private reads and signed delivery.
6. Obtain the separate decision to open customer payment acceptance. Keep signed
   reconciliation available during any admission pause. An accepted payment
   must drain through its original binding; rollback cannot discard its journal.

## Evidence boundary

The pinned staging rehearsal source remains `e00b57c` through migration 025.
This integration is a successor and must carry a separate source identity and
qualification. Its local tests and mock live-account tests do not prove an
actual live merchant, live key, hosted delivery, legal terms acceptance or live
charge. Hosted Checkout, delayed confirmation and signed replay remain pending
the owner's sandbox access confirmation. No production change or live charge
is part of this source integration.
