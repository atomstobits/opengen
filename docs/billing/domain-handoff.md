# Billing domain handoff

Updated **2026-11-06**. This document retains an earlier domain handoff. Follow the [current runtime integration runbook](runtime-integration-026.md) for startup and migration requirements. Its scoped binding requirements supersede the legacy startup guidance below.

2026-11-05. This private review branch starts at the verified billing recovery
checkpoint. It supplies the billing domain, HTTP handlers, UI components and
fixtures for the core integration owner. The shared authentication, worker and
settlement paths still need integration before release.

## Processor identity and ownership

- Register a server-owned tuple of environment ID, Stripe account ID and live mode.
  `registerBillingProcessorEnvironmentInTransaction` rejects retargeting and
  aliases of the same account and mode. A dedicated sandbox requires its own
  verified account ID. A rotated key keeps the same tuple when the account and
  mode agree.
- Construct `StripeBillingTransport` with the configured tuple. Explicitly obtain
  processor proof with `verifyProcessorEnvironment` through the approved activation
  workflow. The verifier accepts a trusted context assertion and performs a bounded
  account read. The source and fixture work use synthetic transport proof.
- Instantiate scoped `PaymentStore`, `BillingCustomerStore` and `RechargeStore`
  with that same environment. Use `verifiedLegacyCheckoutTransport()` to create
  the manual adapter from the same SDK and origin. Its payload still uses the
  existing serializer. Do not wrap an unrelated adapter with another SDK's proof.
- Wire `createBillingWebhookDispatcher` only after the existing raw-body signature
  verification and account and mode checks. Pass the verified adapters, the
  scoped `PaymentStore`, and `routeIntent: (event, id) => payments.routeIntent(event, id)`.
  The dispatcher attaches its configured processor context outside the Stripe
  payload. It routes funding by persisted ownership. Unmatched signed events leave
  an operator-visible pending receipt and a retryable response. Manual PI events
  acknowledge the receipt while Checkout owns credit. Invoice events do not add
  wallet credit.
- The PI advisory lock covers both the ownership claim and final credit transaction.
  The losing flow cannot credit and leaves review evidence. Risk received before
  binding is retained within the same environment and creates a spending hold
  when the payment is bound. A legacy-only store on an upgraded database checks
  the same ownership registry under that lock.
- A previously stored manual Checkout can be qualified by fresh retrieval from
  the verified processor environment. A historical attempted POST without a
  bound Checkout cannot prove that environment and moves to review. It keeps its
  original key and request fields. Existing manual-only installations retain the
  legacy path when no processor environment is configured.

## Shared integration seams

Apply the unnumbered policy, customer, recharge and payment ownership fragments
in the allocation owned by core. Apply the processor registry before its
referencing constraints and payment ownership after the recharge table. Include
an owner environment and mode FK to `mr_billing_processor_environments(id,livemode)`.
Add a tenant-qualified policy mandate FK after the mandate table exists and keep
policy updates fenced by current owner version and environment. Existing manual
order and receipt environment columns start null. Preserve applied migrations
001–021 and verify populated upgrade and restore before activation.

Mount the billing policy endpoints with core's authenticated principal projection
and final-lock callback. Use `billingOperationMetadata` and `billingPolicyInputSchema`
for the four reviewed HTTP/MCP policy and history operations. Generic key and grant
defaults keep their existing scopes. Human setup, approval, portal, delegation and
same-intent card authentication stay outside the agent operation allowlist.

The private billing UI requires a current recovery scope and authoritative billing
capabilities. Register the fixed setup-status GET path `/v1/billing/setups/:id`
through the browser proxy allowlist. It keeps a saved setup readable after creation
is disabled or terms change. Document sync and cached document pagination use
separate cursors. Scope existing manual funding history and Checkout links behind
the approved billing-read boundary when switching to the new mounted surface.
Keep the limited wallet view available to existing authorized users.

The operator review component currently expects an explicitly supplied memory-only
bearer. The existing operator panel uses an HttpOnly bootstrap session. A mount
must either accept the dedicated bearer or use a verified operator-session proxy
that enforces the existing origin and authority rules. A normal billing delegate
cannot use the operator surface.

The worker factory may evaluate current policies only through the explicit
activation gate. Accepted known payment objects remain eligible for read recovery
when new automatic charging is disabled. The outbox callback shares the same
transaction as verified credit. A worker GET, browser return or SCA response cannot
add credit. The paid webhook still validates the original environment, PaymentIntent,
customer, method, currency and exact amount received.

Core owns fee activation, evidence production, generation admission and settlement.
Keep the 500 bps rate, eligible outcomes, overrun allocation, BYOK treatment,
funding-owner appointment and delegation choices at their documented proposal
status until the human decides. The fixture amount cap conservatively counts
non-cancelled admitted attempts, including declines. New fee jobs require current
qualified cost evidence and hold exposure when that evidence is absent.
