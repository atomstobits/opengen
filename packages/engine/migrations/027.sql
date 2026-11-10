-- Freeze the Checkout request contract independently of future serializers.
-- Existing rows and older writers retain v1; only the new writer opts into v2.
-- Never rewrite a historical Stripe idempotency key or its uncertain POST body.
ALTER TABLE mr_payment_orders
  ADD COLUMN checkout_request_version text NOT NULL DEFAULT 'checkout_hosted_v1'
    CHECK (checkout_request_version IN ('checkout_hosted_v1','checkout_hosted_page_v2')),
  ADD COLUMN checkout_api_version text NOT NULL DEFAULT '2026-10-28.endive'
    CHECK (checkout_api_version = '2026-10-28.endive');
