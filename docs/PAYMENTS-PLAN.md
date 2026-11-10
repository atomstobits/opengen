# Prepaid customer top-ups implementation plan

2026-11-03. Development branch; fixture-backed only. No live Stripe account,
charges, provisioning, tax registration or deployment is authorized here.

1. **Contracts and design:** use hosted one-time Stripe Checkout for OpenGen's
   own prepaid USD service credit. Keep the existing PostgreSQL ledger and integer
   microUSD. Read accounting/auth/security and current official Stripe docs.
   Keep secrets server-only. No subscription, automatic recharge, tax automation,
   marketplace platform or new billing platform.
2. **Persist before external requests:** migration 012 adds workspace-owned USD
   orders ($5–$1,000), unique workspace/client retry keys, fixed Stripe request
   parameters and request keys, Checkout/payment identities, reconciliation events,
   and billing holds. Store cents and microUSD with SQL constraints. Bound history.
3. **Checkout and uncertainty:** authenticate human workspace sessions. Persist the
   order first, then mark the attempt before external work. Reuse immutable request
   parameters/key after timeout. Stop external retries before Stripe's idempotency
   retention boundary and retain uncertainty for operator reconciliation. Fixed
   canonical success/cancel URLs; no request-supplied redirect destinations.
4. **Reconcile:** verify signatures over exact raw bytes before any mutation.
   Resolve by persisted session identity; recover a lost create response only by
   replaying the original stored create request/key before the safe cutoff. Validate
   mode, environment, currency, subtotal/total, payment identity and paid state.
   Record duplicates safely and let late paid success dominate stale failures.
   Credit once, atomically with order/event state, through an injected transactional
   credit primitive that the main engine also uses for operator credit.
5. **Risk:** persist refund/dispute events and create workspace holds. Unknown
   payment identities remain recorded and retriable; never trust metadata as
   ownership. A hold and new spend admission serialize on the workspace row.
   Accepted jobs continue settlement. No automatic reversal or hold clearing.
6. **UI/API:** export standalone Billing for onboarding, add authenticated status,
   history, create and Checkout endpoints and isolated proxies. Show pending,
   credited and review states. Preserve retry identity across reloads. Do not collect
   card data or award credit from URL parameters.
7. **Evidence:** signed fixtures, mock Stripe transport, SQL tests with pool size
   one, auth/cross-workspace access, wrong amounts/currency/session, bad/missing
   signatures, timeouts, concurrent/duplicate/out-of-order events, delayed payment,
   rollback and holds. Run focused type/format/secret checks, report baseline
   canonical migration errors separately, and commit only owned files.
8. **Handoff:** exact integration snippets for credit primitive, migration/export,
   server authentication/raw route, admission hold, proxy allowlist and dashboard
   slot. Document required sandbox, native PostgreSQL concurrency and hosted
   browser checks plus live/tax/refund decisions before release.

## Review follow-up: bounded operator API use

Persist workspace and installation fixed-hour admission counters; admit only ten
new orders and thirty customer Checkout calls per workspace per hour, with
installation-wide caps of one thousand/three thousand. Store counters on existing
workspace rows plus one singleton, with no row growth per window/request. Preserve
existing-key replay and free status, cache known sessions for sixty seconds, and
persist a separate cooldown for uncertain outcomes. Return 429 and wait guidance;
never restart orders or refund quota on timeout. Test one-connection caps,
installation isolation, replay at cap, known-session and uncertain retry bounds,
clock/window behavior and native concurrent caps. No Stripe calls are authorized.
