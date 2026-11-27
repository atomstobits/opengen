-- Forward migration 034: Add operator 'resolve' reconciliation action and shorten
-- aged-cost-relief minimum eligibility age from 24 hours to 1 hour.
-- Preserves 001..033 immutability and all transactional money/relief guards.

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'mr_reconciliations'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%action%'
  LOOP
    EXECUTE format('ALTER TABLE mr_reconciliations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE mr_reconciliations
  ADD CONSTRAINT mr_reconciliations_action_check
  CHECK (action IN ('resume', 'reject', 'settle', 'resolve', 'record-supplier-cost'));

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'mr_aged_cost_reliefs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%created_at%'
      AND pg_get_constraintdef(oid) LIKE '%liability_since%'
  LOOP
    EXECUTE format('ALTER TABLE mr_aged_cost_reliefs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE mr_aged_cost_reliefs
  ADD CONSTRAINT mr_aged_cost_reliefs_min_age_check
  CHECK (created_at >= liability_since + interval '1 hour');

CREATE OR REPLACE FUNCTION mr_aged_cost_relief_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  j mr_jobs%ROWTYPE; reserve_entry mr_ledger%ROWTYPE; source_entry mr_ledger%ROWTYPE;
  first_liability timestamptz; item jsonb; payment record; chronology_basis text;
BEGIN
  SELECT * INTO j FROM mr_jobs WHERE workspace_id=NEW.workspace_id AND id=NEW.job_id;
  SELECT * INTO reserve_entry FROM mr_ledger
    WHERE workspace_id=NEW.workspace_id AND job_id=NEW.job_id AND kind='reserve';
  SELECT min(a.started_at) INTO first_liability FROM mr_attempts a
    WHERE a.job_id=NEW.job_id;
  IF j.id IS NULL OR COALESCE(j.input->>'billing','managed')<>'managed'
    OR j.reserved_micros<>NEW.amount_micros OR j.reserved_micros<=0 OR j.attempt_count NOT BETWEEN 1 AND 100
    OR (SELECT count(*) FROM mr_attempts WHERE job_id=j.id)<>j.attempt_count
    OR EXISTS(SELECT 1 FROM mr_attempts WHERE job_id=j.id AND number NOT BETWEEN 1 AND j.attempt_count)
    OR j.settled_micros IS NOT NULL OR j.upstream_cost_micros IS NOT NULL
    OR reserve_entry.id IS NULL OR reserve_entry.amount_micros<>NEW.amount_micros
    OR reserve_entry.available_delta_micros<>-NEW.amount_micros
    OR reserve_entry.reserved_delta_micros<>NEW.amount_micros
    OR first_liability IS NULL OR NEW.liability_since IS DISTINCT FROM first_liability
    OR clock_timestamp()<first_liability+interval '1 hour'
    OR EXISTS(SELECT 1 FROM mr_ledger WHERE job_id=NEW.job_id AND kind IN ('settle','release'))
  THEN RAISE EXCEPTION 'aged_cost_relief_ineligible' USING ERRCODE='23514'; END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(NEW.allocation) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR jsonb_typeof(item->'sourceLedgerId') IS DISTINCT FROM 'string'
      OR COALESCE(item->>'sourceLedgerId','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    THEN RAISE EXCEPTION 'aged_cost_relief_allocation_identity' USING ERRCODE='23514'; END IF;
    SELECT * INTO source_entry FROM mr_ledger WHERE id=(item->>'sourceLedgerId')::uuid;
    IF source_entry.id IS NULL OR source_entry.workspace_id<>NEW.workspace_id
      OR source_entry.job_id IS NOT NULL OR source_entry.kind NOT IN ('credit','opening')
      OR source_entry.amount_micros NOT BETWEEN 1 AND 9007199254740991
      OR source_entry.available_delta_micros<>source_entry.amount_micros
      OR source_entry.reserved_delta_micros<>0
      OR (reserve_entry.posting_order IS NULL AND source_entry.posting_order IS NOT NULL)
      OR (reserve_entry.posting_order IS NOT NULL AND source_entry.posting_order>=reserve_entry.posting_order)
      OR source_entry.reference LIKE 'aged-cost-relief:%'
      OR item->>'sourceReference' IS DISTINCT FROM COALESCE(source_entry.reference,'opening:'||source_entry.id::text)
      OR jsonb_typeof(item->'sourceAmountMicros') IS DISTINCT FROM 'number'
      OR item->>'sourceAmountMicros' IS DISTINCT FROM source_entry.amount_micros::text
    THEN RAISE EXCEPTION 'aged_cost_relief_allocation_source' USING ERRCODE='23514'; END IF;
    chronology_basis:=CASE WHEN reserve_entry.posting_order IS NULL THEN 'independent-staff-evidence'
      WHEN source_entry.posting_order IS NULL THEN 'pre-migration-source' ELSE 'recorded-posting-order' END;
    IF NOT (item ? 'sourcePostingOrder' AND item ? 'reservationPostingOrder')
      OR item->>'sourcePostingOrder' IS DISTINCT FROM source_entry.posting_order::text
      OR item->>'reservationPostingOrder' IS DISTINCT FROM reserve_entry.posting_order::text
      OR item->>'chronologyBasis' IS DISTINCT FROM chronology_basis
    THEN RAISE EXCEPTION 'aged_cost_relief_posting_identity' USING ERRCODE='23514'; END IF;

    IF source_entry.reference ~ '^stripe-(topup|recharge):' THEN
      IF source_entry.kind<>'credit'
        OR (SELECT count(*) FROM mr_ledger WHERE workspace_id=NEW.workspace_id
          AND reference=source_entry.reference)<>1
      THEN RAISE EXCEPTION 'aged_cost_relief_paid_source' USING ERRCODE='23514'; END IF;
      SELECT f.* INTO payment FROM (
        SELECT 'manual'::text AS kind,o.id AS local_id,o.payment_intent_id,
          o.processor_environment_id,o.processor_account_id,o.livemode,o.amount_cents,
          'stripe-topup:'||o.id::text AS credit_reference,o.created_at,o.credited_at
        FROM mr_payment_orders o WHERE o.workspace_id=NEW.workspace_id AND o.status='credited'
          AND o.credited_at IS NOT NULL AND o.credit_micros=o.amount_cents::bigint*10000
        UNION ALL
        SELECT 'automatic',r.id,r.payment_intent_id,r.processor_environment_id,
          r.processor_account_id,r.livemode,r.amount_cents,'stripe-recharge:'||r.id::text,
          r.created_at,r.credited_at
        FROM mr_billing_recharge_attempts r WHERE r.workspace_id=NEW.workspace_id
          AND r.status='succeeded' AND r.credited_at IS NOT NULL
      ) f JOIN mr_billing_payment_ownership p ON p.workspace_id=NEW.workspace_id
        AND p.credit_reference=f.credit_reference AND p.kind=f.kind AND p.local_id=f.local_id
        AND p.payment_intent_id=f.payment_intent_id AND p.processor_environment_id=f.processor_environment_id
        AND p.livemode=f.livemode AND p.amount_cents=f.amount_cents AND p.currency='USD'
      JOIN mr_billing_processor_environments e ON e.id=f.processor_environment_id
        AND e.account_id=f.processor_account_id AND e.livemode=f.livemode
      WHERE f.credit_reference=source_entry.reference
        AND f.amount_cents::bigint*10000=source_entry.amount_micros;
      IF NOT FOUND OR item->>'character' IS DISTINCT FROM 'paid'
        OR item->'originalPayment' IS DISTINCT FROM jsonb_build_object(
          'kind',payment.kind,'localId',payment.local_id,'paymentIntentId',payment.payment_intent_id,
          'processorEnvironmentId',payment.processor_environment_id,
          'processorAccountId',payment.processor_account_id,'livemode',payment.livemode,
          'originalAmountCents',payment.amount_cents,
          'createdAt',to_char(payment.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'creditedAt',to_char(payment.credited_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      THEN RAISE EXCEPTION 'aged_cost_relief_paid_identity' USING ERRCODE='23514'; END IF;
    ELSIF item->>'character' IS DISTINCT FROM 'noncash'
      OR item->'originalPayment' IS DISTINCT FROM 'null'::jsonb
    THEN RAISE EXCEPTION 'aged_cost_relief_noncash_identity' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
