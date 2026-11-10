# Payments integration contract

2026-11-03. Optional payment modules, shared core wiring and the dedicated hosted
webhook relay are integrated. No Stripe sandbox or live payment has run. See PAYMENTS-PLAN.md and PAYMENTS.md for evidence/operations.

## Engine wiring (implemented)

Migration `012.sql` is in the checksummed sequence after `011.sql`, and the engine
exports `payments.js`. Existing migrations 001–011 remain unchanged.

The existing credit transaction rules are shared through the exported helper:

```ts
export declare function creditWorkspaceInTransaction(
  client: PoolClient,
  workspaceId: string,
  amountMicros: number,
  reference: string,
): Promise<void>;
```

It preserves amount/reference validation, the workspace row lock, reference
conflict checks, safe-integer total balance and ledger insertion. It uses only
`client.query`; the caller owns BEGIN/COMMIT/ROLLBACK. `creditWorkspace` invokes
it inside the existing engine transaction, then reads the balance afterward.

`packages/engine/src/payments.ts` exports `CreditInTransaction` with that exact
signature. The configured store receives the same engine pool:

```ts
const payments = new PaymentStore(engine.pool, {
  creditInTransaction: creditWorkspaceInTransaction,
  livemode: false, // explicit server environment setting; no frontend variable
});
```

PaymentStore invokes the helper inside its own transaction after locking the
workspace and order. Its reference is `stripe-topup:${order.id}`. Event, payment
status, risk holds, balance and credit ledger entry commit together. The helper
must not call `engine.creditWorkspace`, use `pool.query`, acquire a new connection,
or return a balance by querying the pool. Pool size one must remain supported.

## Spending hold hook (implemented)

The engine checks **every new managed or BYOK admission** after obtaining the
workspace row lock and after idempotent-job replay, before a new quote/reservation/job.
The query uses that same transaction client:

```ts
const hold = await client.query(
  `SELECT 1 FROM mr_billing_holds
   WHERE workspace_id=$1 AND resolved_at IS NULL LIMIT 1`,
  [workspaceId],
);
if (hold.rowCount)
  throw new EngineError('billing_hold', 'Billing needs review before new generation.', 409);
```

Replay of an already accepted idempotent job remains available. The guard is
absent from polling, cancellation, reservation release, late settlement and
reconciliation so accepted jobs continue to finish.
PaymentStore takes the same workspace row lock before inserting a risk hold, so
native PostgreSQL serializes hold creation with new admission; a nontransactional
`hasBillingHold` read is only for UI and is insufficient as an admission guard.
Holds are explicit rows per verified refund/dispute event and never auto-clear.
No customer/API hold-clear endpoint is provided. Operator review must record a
resolution reference and preserve ledger history. No automatic balance reversal,
fabricated refund or negative balance is implemented.

## Server and web wiring

Server registration is wired after existing account/cookie registration and
reuses the same browser-authentication closure, including membership checks.
Stripe transport remains injectable for fixtures and disabled installations.
Customer billing requires `og_session`, rejects Authorization/bootstrap/OAuth,
checks `read`, exact Origin on mutation and `X-OpenGen-Workspace` against principal.
No new privileged scope is implicitly granted to agent tokens.

The API registers its raw-body Stripe webhook only at `/webhooks/stripe`. Its
encapsulated parser produces Buffer bytes before verification. A publicly
reachable self-hosted API can receive Stripe directly. A private Cloud Run API
receives through the dedicated Vercel POST `/webhooks/stripe` relay: it sends
original ArrayBuffer bytes and Stripe-Signature to that same fixed API path,
using the existing keyless WIF service identity. No Stripe secret is placed on
Vercel. Caller authorization/session/workspace headers are stripped and missing
identity fails closed. Keep the IAM-private backend; no unauthenticated Cloud Run
grant is needed. Do not substitute a JSON-reencoding proxy or generic `/api`
generation callback for this byte-preserving relay.

`AppOptions`/`EngineLike` carry the configured PaymentStore into the mounted
registration. The existing account-registration result supplies authentication:

```ts
import { createStripeClient, registerPayments } from './payments.js';
// In the same scope as the existing authenticateBrowser closure:
await registerPayments(app, {
  store: options.payments, // PaymentStore created with engine.pool and helper
  authenticate: (request) => authenticateBrowser(request),
  stripe: serverStripeKey ? createStripeClient(serverStripeKey) : undefined,
  webhookSecret: serverStripeWebhookSecret,
  publicUrl: canonicalPublicUrl, // same origin used by accounts/browser CSRF
  livemode: false, // sandbox only until separately approved live launch
});
```

Disabled installations pass no Stripe client/secret; history can use the store
with the installed payment schema. Parse live-mode configuration explicitly;
never use Boolean("false"). Do not expose any server key through AppOptions sent to
React. Reject thin/Connect destinations and configure snapshot events on the exact
pinned API version. The endpoint path itself is fixed in `registerPayments`.

Shared human-billing integration is four HTTP-only `protocolTargets` and
forwarding `x-opengen-workspace`, listed verbatim in PAYMENTS-UI-INTEGRATION.md.
The dedicated webhook adds one separate fixed POST transport target. Include
billing paths in any native-gateway transport match/CSP edge configuration where
that transport requires an explicit registration; keep them out of MCP delegation.
Register only the fixed POST `/webhooks/stripe` transport target. The dedicated
frontend route preserves raw bytes, bounds input at 1,000,000 bytes and forwards
Stripe-Signature plus Content-Type, adding only trusted GCP service identity.
Backend signature verification is its sole payment authority; cookie
authentication and delegated MCP operations do not apply.
The standalone web page is `/billing`; `Billing` accepts
`workspaceId` for dashboard placement. It has no dependency on dashboard/workspace.

## Dependency integration

The server manifest pins `stripe: 23.1.0`; the shared lockfile is integrated. The official SDK package
`esm/apiVersion.js` and current Stripe docs were checked: `2026-10-28.endive`.
No Metronome/Connect/billing-platform dependency is needed. No secret config is
copied from another checkout.

## Durable request limits and Retry-After (implemented)

Migration 012 includes fixed counters on workspace rows, one installation
singleton and a persisted per-order cooldown. It remains undeployed; migrations
001–011 are unchanged. PaymentStore enforces the limits below independently of
HTTP mounting, and the shared error handler/proxy preserve retry guidance.

Order caps: 10/workspace/hour and 1,000/installation/hour. Actual customer Checkout
create/retrieve caps: 30/workspace/hour and 3,000/installation/hour. A 60-second
cooldown caches known sessions and prevents rapid unknown-outcome retries. All
outbound admissions commit before the external request; timeout and retry never
refund counters or clear the cooldown. Status/history and existing-key order
replay remain readable; rate denial neither changes the order nor creates a new
retry identity. Signed webhook reconciliation is separate and remains available.

The shared Fastify error handler includes the typed field and sets the standard
header for rate errors; the message also retains wait/same-order guidance:

```ts
const e = error as {
  statusCode?: number;
  code?: string;
  message: string;
  name?: string;
  retryAfterSeconds?: number;
};
if (e.statusCode === 429 && Number.isSafeInteger(e.retryAfterSeconds) && e.retryAfterSeconds! > 0)
  reply.header('Retry-After', String(e.retryAfterSeconds));
// Preserve the existing status/error serialization and redaction.
```

The website proxy already forwards `retry-after`. Clients should wait that many
seconds and resume the same order; never invent a new key to evade a cap. Run
`tests/payment-rate-limits.test.ts` with the SQL fixture suite, and the four new
cap schedules in `payment-concurrency.test.ts` with TEST_NATIVE_POSTGRES=1 against
a disposable native PostgreSQL database. The serial payments fixture runner now
includes the rate-limit suite.

## Integrated verification boundary

The production credit helper, spend-admission guard, payment schema, durable
caps, HTTP mounting, billing UI/proxies and dedicated raw-byte WIF relay are
integrated in the candidate. Current TypeScript, SQL, browser, build and hygiene
results are recorded in [VERIFICATION.md](VERIFICATION.md). Native locking races
remain enabled for PostgreSQL CI and unexecuted locally. No Stripe sandbox/live
charge, hosted identity-provider flow or deployed WIF delivery has been verified.
