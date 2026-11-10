# Billing UI integration

Updated 2026-11-03. The integration supplies a standalone `/billing` page, an exported `Billing` component and four fixed frontend billing proxy routes, with shared HTTP-only transport registration. The separate webhook relay preserves signed bytes for the private backend. It is fixture-backed; deployment and Stripe sandbox/browser verification are still required.

## Dashboard placement

Onboarding can link directly to `/billing`. For an embedded view, use the authenticated selected workspace, and remount when it changes:

```tsx
import { Billing } from '../billing/billing';

<Billing key={session.workspaceId} workspaceId={session.workspaceId} />;
```

The standalone page resolves `/api/session` before mounting the component. A signed-out customer sees sign-in when OIDC is configured, otherwise a workspace link; no operator/provider credential form is introduced.

## Required shared transport changes

In `apps/web/app/registered-http.ts`, append these HTTP-only entries to `protocolTargets`. They need not become agent business operations:

```ts
{ method: 'GET', path: '/v1/billing' },
{ method: 'POST', path: '/v1/billing/orders' },
{ method: 'GET', path: '/v1/billing/orders/:id' },
{ method: 'POST', path: '/v1/billing/orders/:id/checkout' },
```

In `apps/web/app/proxy.ts`, append `'x-opengen-workspace'` to the existing forwarded request-header list. Keep existing `'cookie'`, `'origin'` and `'idempotency-key'` forwarding. The payment server requires `X-OpenGen-Workspace` to match the authenticated cookie workspace; this prevents another-tab workspace changes from silently funding a different workspace. No installation/operator bearer token is injected. Until these two integration changes land, the existing proxy intentionally returns 404 for these unregistered routes.

Frontend routes are fixed mappings:

| Website                            | Gateway                           | Method |
| ---------------------------------- | --------------------------------- | ------ |
| `/api/billing`                     | `/v1/billing`                     | GET    |
| `/api/billing/orders`              | `/v1/billing/orders`              | POST   |
| `/api/billing/orders/:id`          | `/v1/billing/orders/:id`          | GET    |
| `/api/billing/orders/:id/checkout` | `/v1/billing/orders/:id/checkout` | POST   |

A publicly reachable self-hosted API can receive Stripe directly at its signed `/webhooks/stripe` endpoint. With the IAM-private Cloud Run API, Stripe instead posts to the dedicated public Vercel `/webhooks/stripe` route. That relay preserves exact bytes and Stripe-Signature, strips browser/agent headers and adds the existing keyless GCP identity; GCP alone holds Stripe secrets and verifies/fulfills events. Keep this fixed POST transport target outside MCP delegation. Do not use the generic JSON/text proxy branch, which cannot preserve every signed byte representation.

## Recovery and status behavior

The UI writes `opengen.billing.v1:<workspaceId>` to localStorage before creating an order. It contains only a version, workspace ID, integer cents amount, random client idempotency key and (when known) order UUID. It contains no credential, card information or Checkout URL. Storage failure pauses creation. Reload and timeout retry preserve both amount and key. Known orders resume by authenticated GET and Checkout POST rather than creating another order. An unresolved request cannot change its amount. Corrupt recovery state fails closed and asks the customer to review payment history.

The recovery record remains until an explicit **Start another top-up** action performs an authenticated read confirming that the same owned order is credited, failed or expired. A return URL never removes the record or grants credit. The page displays separate pending, confirmed, failed, expired and review states; delayed payments remain pending. Visible open/pending orders poll every ten seconds while the tab is visible. Checkout navigation accepts only HTTPS URLs on `checkout.stripe.com`.

`?checkout=success|cancel&order=<UUID>` is a display/status hint only. `Billing` fetches the owned order from the gateway before displaying its status. A cancel return can resume the same open Checkout. Credited history remains visible after the customer starts a new top-up.

## Verification

`tests/payments-ui.test.ts` checks persisted-before-POST recovery, timeout replay using the identical workspace/key/body, reload GET of an existing order, rejection of a changed amount, malformed response and failed storage, cross-workspace responses, terminal-only recovery release, exact decimal cents and the Stripe redirect boundary. Five fixture tests pass using Node 22.23.2. No browser run, Stripe session, charge, secret lookup, deployment or heavy build was performed by this UI task. Integration must verify signed-out, held, unconfigured, timeout/reload, delayed, credited, failed and cancel-return states on desktop and phone after route wiring.
