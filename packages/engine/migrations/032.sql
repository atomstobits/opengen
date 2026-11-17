-- Public self-serve launch billing: $5-$9,999 credit principal, upfront processing
-- fee gross-up columns, saved-card BIN country, and legacy zero-fee writer safety.
-- Keep amount_cents as the credit principal (credit_micros = amount_cents * 10000)
-- so 030 staff-refund and 031 aged-cost-relief ledger invariants hold unchanged.

ALTER TABLE mr_payment_orders
  DROP CONSTRAINT mr_payment_orders_amount_cents_check,
  DROP CONSTRAINT mr_payment_orders_checkout_request_version_check,
  ADD CONSTRAINT mr_payment_orders_amount_cents_check CHECK (amount_cents BETWEEN 500 AND 999900),
  ADD CONSTRAINT mr_payment_orders_checkout_request_version_check
    CHECK (checkout_request_version IN ('checkout_hosted_v1','checkout_hosted_page_v2','checkout_hosted_page_fee_v3')),
  ADD COLUMN fee_cents integer NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  ADD COLUMN fee_rate_bps integer NOT NULL DEFAULT 0 CHECK (fee_rate_bps IN (0, 290, 440)),
  ADD COLUMN total_charge_cents integer;
UPDATE mr_payment_orders SET total_charge_cents = amount_cents + fee_cents WHERE total_charge_cents IS NULL;
ALTER TABLE mr_payment_orders
  ALTER COLUMN total_charge_cents SET NOT NULL,
  ADD CONSTRAINT mr_payment_orders_total_charge_cents_check CHECK (total_charge_cents = amount_cents + fee_cents);

ALTER TABLE mr_billing_policies
  DROP CONSTRAINT mr_billing_policies_amount_cents_check,
  ADD CONSTRAINT mr_billing_policies_amount_cents_check CHECK (amount_cents BETWEEN 500 AND 999900);

ALTER TABLE mr_billing_mandates
  ADD COLUMN card_country text CHECK (card_country IS NULL OR card_country ~ '^[A-Z]{2}$');

ALTER TABLE mr_billing_recharge_attempts
  DROP CONSTRAINT mr_billing_recharge_attempts_amount_cents_check,
  DROP CONSTRAINT mr_billing_recharge_attempts_request_version_check,
  ADD CONSTRAINT mr_billing_recharge_attempts_amount_cents_check CHECK (amount_cents BETWEEN 500 AND 999900),
  ADD CONSTRAINT mr_billing_recharge_attempts_request_version_check
    CHECK (request_version IN ('recharge_pi_v1','recharge_pi_fee_v2')),
  ADD COLUMN fee_cents integer NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  ADD COLUMN fee_rate_bps integer NOT NULL DEFAULT 0 CHECK (fee_rate_bps IN (0, 290, 440)),
  ADD COLUMN total_charge_cents integer;
UPDATE mr_billing_recharge_attempts SET total_charge_cents = amount_cents + fee_cents WHERE total_charge_cents IS NULL;
ALTER TABLE mr_billing_recharge_attempts
  ALTER COLUMN total_charge_cents SET NOT NULL,
  ADD CONSTRAINT mr_billing_recharge_attempts_total_charge_cents_check CHECK (total_charge_cents = amount_cents + fee_cents);

ALTER TABLE mr_billing_payment_ownership
  DROP CONSTRAINT mr_billing_payment_ownership_amount_cents_check,
  ADD CONSTRAINT mr_billing_payment_ownership_amount_cents_check CHECK (amount_cents BETWEEN 500 AND 999900),
  ADD COLUMN fee_cents integer NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  ADD COLUMN total_charge_cents integer;
UPDATE mr_billing_payment_ownership SET total_charge_cents = amount_cents + fee_cents WHERE total_charge_cents IS NULL;
ALTER TABLE mr_billing_payment_ownership
  ALTER COLUMN total_charge_cents SET NOT NULL,
  ADD CONSTRAINT mr_billing_payment_ownership_total_charge_cents_check CHECK (total_charge_cents = amount_cents + fee_cents);

ALTER TABLE mr_staff_refund_cases
  DROP CONSTRAINT mr_staff_refund_cases_original_amount_cents_check,
  DROP CONSTRAINT mr_staff_refund_cases_eligible_micros_check,
  ADD CONSTRAINT mr_staff_refund_cases_original_amount_cents_check CHECK (original_amount_cents BETWEEN 500 AND 999900),
  ADD CONSTRAINT mr_staff_refund_cases_eligible_micros_check CHECK (eligible_micros > 0 AND eligible_micros <= 9999000000);

-- Legacy zero-fee writers omit total_charge_cents; fee-bearing rows must pass it explicitly.
CREATE FUNCTION mr_billing_total_charge_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.total_charge_cents IS NULL AND NEW.fee_cents = 0 AND NEW.amount_cents IS NOT NULL THEN
    NEW.total_charge_cents := NEW.amount_cents;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_payment_orders_total_charge_default BEFORE INSERT ON mr_payment_orders
  FOR EACH ROW EXECUTE FUNCTION mr_billing_total_charge_default();
CREATE TRIGGER mr_billing_recharge_attempts_total_charge_default BEFORE INSERT ON mr_billing_recharge_attempts
  FOR EACH ROW EXECUTE FUNCTION mr_billing_total_charge_default();
CREATE TRIGGER mr_billing_payment_ownership_total_charge_default BEFORE INSERT ON mr_billing_payment_ownership
  FOR EACH ROW EXECUTE FUNCTION mr_billing_total_charge_default();
