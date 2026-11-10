# Hosted Checkout request compatibility

A hosted sandbox attempt on source `292e462` was rejected because the serialized `ui_mode: 'hosted'` is incompatible with the pinned Stripe API. The corrected source has local contract regressions; it requires fresh hosted qualification before acceptance. Neither this change nor the fixtures establish a successful hosted payment.

The [Checkout create reference for `2026-10-28.endive`](https://docs.stripe.com/api/checkout/sessions/create?api-version=2026-10-28.endive) documents `hosted_page` as the hosted UI and default. Stripe Node 23.1.0 also lists that enum, but its forward-compatible `OtherString` type admits arbitrary strings. Compilation alone therefore did not catch the incompatible value. The SDK and API version remain unchanged.

## Persisted request identities

| Journey                    | Historical request    | New request               |
| -------------------------- | --------------------- | ------------------------- |
| Manual prepaid Checkout    | `checkout_hosted_v1`  | `checkout_hosted_page_v2` |
| Saved payment setup        | `setup_checkout_v1`   | `setup_checkout_v2`       |
| Optional invoice transport | `customer_invoice_v2` | `customer_invoice_v3`     |

Migration 027 adds manual Checkout serializer and API version columns. Existing rows and the database insertion default retain the historical version. Only the new writer explicitly inserts the corrected version. Setup keeps its existing historical database default and explicitly inserts the new version and retry-key prefix. The invoice helper remains unmounted; its new version adds no caller or activation. A future caller must persist a fresh invoice-v3 identity and key; changing the version under an existing manual or invoice key is forbidden.

Historical unbound requests fail locally before external admission, quotas, timestamps or leases change. Their original keys and request data remain available for operator investigation. Do not rewrite or retry an existing uncertain request with the corrected serializer. Known session retrieval and verified webhook reconciliation remain available across both versions; a response UI enum is not payment or nonacceptance evidence. Monetary, session, environment and tenant checks still govern fulfillment.

New requests explicitly send `hosted_page` and their stored API version. Replays preserve the version, form payload, expiry, amount and idempotency key. [Stripe's idempotency rules](https://docs.stripe.com/api/idempotent_requests) require preserving the original parameters when a key is reused. The historical failed acceptance order is preserved separately; requalification must use fresh orders and keys.

## Qualification and rollback

Keep Checkout paused during rollout. Build and deploy the corrected paused source and additive migration, then verify the source digest, versioned rows, secret references, private authorization and disabled provider execution before any separately approved open test.

An older process ignores the new version columns. The historical database default protects older writers from mislabelling requests; it cannot make an older reader safe for corrected rows. After new-version writes, never route Checkout traffic to an older open process. A rollback must keep Checkout paused. Existing signed fulfillment and investigation reads remain available.

Offline regressions cover actual SDK header/form encoding for all three new serializers, refusal of historical unbound POSTs before quota or lease mutation, stable new-version timeout recovery, historical known-session fulfillment, and populated migration/dump/restore. Actual Checkout, signed hosted relay, delayed methods and replay evidence remain separate release gates.
