-- One explicitly approved operator advance for an aged unresolved generation.
-- Original customer/provider settlement, reservation and key exposure remain intact.
-- Old posting order is unknown. Record only new postings, while holding the
-- same workspace money lock as all supported financial writers.
ALTER TABLE mr_ledger ADD COLUMN posting_order bigint;
CREATE SEQUENCE mr_ledger_posting_order_seq OWNED BY mr_ledger.posting_order;
CREATE UNIQUE INDEX mr_ledger_posting_order_unique ON mr_ledger(posting_order);
CREATE FUNCTION mr_ledger_record_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.posting_order IS DISTINCT FROM OLD.posting_order
    THEN RAISE EXCEPTION 'ledger_posting_order_immutable' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM mr_workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  NEW.posting_order:=nextval('mr_ledger_posting_order_seq');
  RETURN NEW;
END $$;
CREATE TRIGGER mr_ledger_record_posting BEFORE INSERT OR UPDATE ON mr_ledger
  FOR EACH ROW EXECUTE FUNCTION mr_ledger_record_posting();

CREATE TABLE mr_aged_cost_reliefs (
  job_id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request_version text NOT NULL DEFAULT 'aged-cost-relief-v1'
    CHECK (request_version='aged-cost-relief-v1'),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 120),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  allocation jsonb NOT NULL CHECK (
    jsonb_typeof(allocation)='array' AND jsonb_array_length(allocation) BETWEEN 1 AND 100
  ),
  amount_micros bigint NOT NULL CHECK (amount_micros BETWEEN 1 AND 9007199254740991),
  credit_ledger_id uuid NOT NULL UNIQUE REFERENCES mr_ledger(id),
  approval_reference text NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 200),
  approval_hash text NOT NULL CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor)='object'),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  evidence_url text NOT NULL,
  liability_since timestamptz NOT NULL CHECK (isfinite(liability_since)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  FOREIGN KEY(workspace_id,job_id) REFERENCES mr_jobs(workspace_id,id),
  UNIQUE(workspace_id,reference),
  CHECK (approval_hash=request_hash),
  CHECK (snapshot->'allocation' IS NOT DISTINCT FROM allocation),
  CHECK (created_at >= liability_since + interval '24 hours')
);

CREATE TABLE mr_aged_cost_relief_settlements (
  job_id uuid PRIMARY KEY REFERENCES mr_aged_cost_reliefs(job_id),
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  advance_micros bigint NOT NULL CHECK (advance_micros BETWEEN 0 AND 9007199254740991),
  gross_charge_micros bigint NOT NULL CHECK (gross_charge_micros BETWEEN 0 AND 9007199254740991),
  recovered_micros bigint NOT NULL CHECK (recovered_micros BETWEEN 0 AND 9007199254740991),
  operator_funded_micros bigint NOT NULL CHECK (operator_funded_micros BETWEEN 0 AND 9007199254740991),
  settle_ledger_id uuid NOT NULL REFERENCES mr_ledger(id),
  release_ledger_id uuid NOT NULL REFERENCES mr_ledger(id),
  offset_ledger_id uuid NOT NULL UNIQUE REFERENCES mr_ledger(id),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  CHECK (advance_micros=gross_charge_micros+recovered_micros),
  CHECK (operator_funded_micros=gross_charge_micros)
);

ALTER TABLE mr_ledger DROP CONSTRAINT mr_ledger_kind_check;
ALTER TABLE mr_ledger ADD CONSTRAINT mr_ledger_kind_check
  CHECK(kind IN ('opening','reserve','release','settle','credit','refund','refund-restore','relief-offset'));

-- Eligibility is checked while the original unresolved job still exists.
CREATE FUNCTION mr_aged_cost_relief_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR clock_timestamp()<first_liability+interval '24 hours'
    OR EXISTS(SELECT 1 FROM mr_ledger WHERE job_id=NEW.job_id AND kind IN ('settle','release'))
  THEN RAISE EXCEPTION 'aged_cost_relief_ineligible' USING ERRCODE='23514'; END IF;

  -- Funding character is established once, from the original paid/noncash source.
  -- Later refund/risk status changes must not block this job's cost reconciliation.
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
CREATE TRIGGER mr_aged_cost_relief_admission_guard BEFORE INSERT ON mr_aged_cost_reliefs
  FOR EACH ROW EXECUTE FUNCTION mr_aged_cost_relief_admission_guard();

-- Validate the complete transaction, including entries inserted after the grant.
CREATE FUNCTION mr_check_aged_cost_relief(relief_job uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  g mr_aged_cost_reliefs%ROWTYPE; s mr_aged_cost_relief_settlements%ROWTYPE;
  j mr_jobs%ROWTYPE; advance_entry mr_ledger%ROWTYPE; settle_entry mr_ledger%ROWTYPE;
  release_entry mr_ledger%ROWTYPE; offset_entry mr_ledger%ROWTYPE; source_entry mr_ledger%ROWTYPE;
  item jsonb; source_id uuid; allocation_amount bigint; allocated numeric:=0;
  sources uuid[]:=ARRAY[]::uuid[];
BEGIN
  SELECT * INTO g FROM mr_aged_cost_reliefs WHERE job_id=relief_job;
  SELECT * INTO j FROM mr_jobs WHERE id=relief_job;
  SELECT * INTO advance_entry FROM mr_ledger WHERE id=g.credit_ledger_id;
  IF g.job_id IS NULL OR j.id IS NULL OR j.workspace_id<>g.workspace_id
    OR j.reserved_micros<>g.amount_micros OR COALESCE(j.input->>'billing','managed')<>'managed'
    OR advance_entry.id IS NULL OR advance_entry.workspace_id<>g.workspace_id
    OR advance_entry.job_id IS NOT NULL OR advance_entry.kind<>'credit'
    OR advance_entry.reference IS DISTINCT FROM 'aged-cost-relief:'||g.job_id::text||':advance'
    OR advance_entry.amount_micros<>g.amount_micros
    OR advance_entry.available_delta_micros<>g.amount_micros
    OR advance_entry.reserved_delta_micros<>0
  THEN RAISE EXCEPTION 'aged_cost_relief_credit_identity' USING ERRCODE='23514'; END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(g.allocation) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR jsonb_typeof(item->'sourceLedgerId') IS DISTINCT FROM 'string'
      OR COALESCE(item->>'sourceLedgerId','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      OR jsonb_typeof(item->'amountMicros') IS DISTINCT FROM 'number'
      OR COALESCE(item->>'amountMicros','') !~ '^[1-9][0-9]{0,15}$'
    THEN RAISE EXCEPTION 'aged_cost_relief_allocation_identity' USING ERRCODE='23514'; END IF;
    IF (item->>'amountMicros')::numeric>9007199254740991
    THEN RAISE EXCEPTION 'aged_cost_relief_allocation_amount' USING ERRCODE='23514'; END IF;
    source_id:=(item->>'sourceLedgerId')::uuid;
    allocation_amount:=(item->>'amountMicros')::bigint;
    IF source_id=ANY(sources)
    THEN RAISE EXCEPTION 'aged_cost_relief_allocation_duplicate' USING ERRCODE='23514'; END IF;
    sources:=array_append(sources,source_id);
    SELECT * INTO source_entry FROM mr_ledger WHERE id=source_id;
    IF source_entry.id IS NULL OR source_entry.workspace_id<>g.workspace_id
      OR source_entry.job_id IS NOT NULL OR source_entry.kind NOT IN ('credit','opening')
      OR source_entry.amount_micros NOT BETWEEN 1 AND 9007199254740991
      OR source_entry.available_delta_micros<>source_entry.amount_micros
      OR source_entry.reserved_delta_micros<>0 OR allocation_amount>source_entry.amount_micros
      OR source_id=g.credit_ledger_id
    THEN RAISE EXCEPTION 'aged_cost_relief_allocation_source' USING ERRCODE='23514'; END IF;
    allocated:=allocated+allocation_amount;
  END LOOP;
  IF allocated<>g.amount_micros
  THEN RAISE EXCEPTION 'aged_cost_relief_allocation_total' USING ERRCODE='23514'; END IF;

  SELECT * INTO s FROM mr_aged_cost_relief_settlements WHERE job_id=g.job_id;
  IF j.settled_micros IS NULL THEN
    IF s.job_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM mr_ledger WHERE job_id=g.job_id AND kind IN ('settle','release'))
    THEN RAISE EXCEPTION 'aged_cost_relief_premature_settlement' USING ERRCODE='23514'; END IF;
    RETURN;
  END IF;
  SELECT * INTO settle_entry FROM mr_ledger WHERE id=s.settle_ledger_id;
  SELECT * INTO release_entry FROM mr_ledger WHERE id=s.release_ledger_id;
  SELECT * INTO offset_entry FROM mr_ledger WHERE id=s.offset_ledger_id;
  IF s.job_id IS NULL OR s.workspace_id<>g.workspace_id OR s.advance_micros<>g.amount_micros
    OR j.upstream_cost_micros IS NULL
    OR s.receipt->>'upstreamCostMicros' IS DISTINCT FROM j.upstream_cost_micros::text
    OR settle_entry.details->>'upstreamCostMicros' IS DISTINCT FROM j.upstream_cost_micros::text
    OR s.gross_charge_micros<>j.settled_micros
    OR settle_entry.id IS NULL OR settle_entry.workspace_id<>g.workspace_id
    OR settle_entry.job_id IS DISTINCT FROM g.job_id OR settle_entry.kind<>'settle'
    OR settle_entry.amount_micros<>s.gross_charge_micros
    OR settle_entry.available_delta_micros<>0
    OR settle_entry.reserved_delta_micros<>-s.gross_charge_micros
    OR release_entry.id IS NULL OR release_entry.workspace_id<>g.workspace_id
    OR release_entry.job_id IS DISTINCT FROM g.job_id OR release_entry.kind<>'release'
    OR release_entry.amount_micros<>s.recovered_micros
    OR release_entry.available_delta_micros<>s.recovered_micros
    OR release_entry.reserved_delta_micros<>-s.recovered_micros
    OR offset_entry.id IS NULL OR offset_entry.workspace_id<>g.workspace_id
    OR offset_entry.job_id IS NOT NULL OR offset_entry.kind<>'relief-offset'
    OR offset_entry.reference IS DISTINCT FROM 'aged-cost-relief:'||g.job_id::text||':unused-advance'
    OR offset_entry.amount_micros<>s.recovered_micros
    OR offset_entry.available_delta_micros<>-s.recovered_micros OR offset_entry.reserved_delta_micros<>0
    OR s.receipt->>'workspaceId' IS DISTINCT FROM g.workspace_id
    OR s.receipt->>'jobId' IS DISTINCT FROM g.job_id::text
    OR s.receipt->>'advanceMicros' IS DISTINCT FROM s.advance_micros::text
    OR s.receipt->>'grossChargeMicros' IS DISTINCT FROM s.gross_charge_micros::text
    OR s.receipt->>'recoveredMicros' IS DISTINCT FROM s.recovered_micros::text
    OR s.receipt->>'operatorFundedMicros' IS DISTINCT FROM s.operator_funded_micros::text
    OR s.receipt->>'supplierCostScope' IS DISTINCT FROM 'current-attempt'
    OR jsonb_typeof(s.receipt->'unverifiedPredecessors') IS DISTINCT FROM 'array'
    OR s.receipt->>'unverifiedPredecessorCount' IS DISTINCT FROM
      (SELECT count(*)::text FROM mr_attempts WHERE job_id=g.job_id AND number<>j.attempt_count)
    OR jsonb_array_length(s.receipt->'unverifiedPredecessors')<>
      (SELECT count(*) FROM mr_attempts WHERE job_id=g.job_id AND number<>j.attempt_count)
    OR s.receipt->'currentCostScope'->>'attemptNumber' IS DISTINCT FROM j.attempt_count::text
    OR s.receipt->'currentCostScope'->>'attemptId' IS DISTINCT FROM
      (SELECT id::text FROM mr_attempts WHERE job_id=g.job_id AND number=j.attempt_count)
    OR s.receipt->'currentCostScope'->>'providerCostMicros' IS DISTINCT FROM j.upstream_cost_micros::text
    OR s.receipt->>'settleLedgerId' IS DISTINCT FROM s.settle_ledger_id::text
    OR s.receipt->>'releaseLedgerId' IS DISTINCT FROM s.release_ledger_id::text
    OR s.receipt->>'offsetLedgerId' IS DISTINCT FROM s.offset_ledger_id::text
  THEN RAISE EXCEPTION 'aged_cost_relief_settlement_identity' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION mr_aged_cost_relief_deferred_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE relief_job uuid;
BEGIN
  IF TG_TABLE_NAME='mr_jobs' THEN
    SELECT job_id INTO relief_job FROM mr_aged_cost_reliefs WHERE job_id=NEW.id;
  ELSIF TG_TABLE_NAME='mr_ledger' THEN
    SELECT job_id INTO relief_job FROM mr_aged_cost_reliefs WHERE credit_ledger_id=NEW.id;
    IF relief_job IS NULL THEN
      SELECT job_id INTO relief_job FROM mr_aged_cost_relief_settlements WHERE offset_ledger_id=NEW.id;
    END IF;
    IF relief_job IS NULL AND (NEW.kind='relief-offset' OR NEW.reference LIKE 'aged-cost-relief:%')
    THEN RAISE EXCEPTION 'aged_cost_relief_orphan_ledger' USING ERRCODE='23514'; END IF;
    IF relief_job IS NULL AND NEW.job_id IS NOT NULL THEN
      SELECT job_id INTO relief_job FROM mr_aged_cost_reliefs WHERE job_id=NEW.job_id;
    END IF;
  ELSE
    relief_job:=NEW.job_id;
  END IF;
  IF relief_job IS NOT NULL THEN PERFORM mr_check_aged_cost_relief(relief_job); END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER mr_aged_cost_relief_grant_guard AFTER INSERT ON mr_aged_cost_reliefs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mr_aged_cost_relief_deferred_guard();
CREATE CONSTRAINT TRIGGER mr_aged_cost_relief_settlement_guard AFTER INSERT ON mr_aged_cost_relief_settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mr_aged_cost_relief_deferred_guard();
CREATE CONSTRAINT TRIGGER mr_aged_cost_relief_ledger_guard AFTER INSERT OR UPDATE ON mr_ledger
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mr_aged_cost_relief_deferred_guard();
CREATE CONSTRAINT TRIGGER mr_aged_cost_relief_job_guard AFTER UPDATE ON mr_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mr_aged_cost_relief_deferred_guard();

CREATE FUNCTION mr_aged_cost_relief_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'aged_cost_relief_immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER mr_aged_cost_reliefs_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mr_aged_cost_reliefs
  FOR EACH STATEMENT EXECUTE FUNCTION mr_aged_cost_relief_immutable();
CREATE TRIGGER mr_aged_cost_relief_settlements_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON mr_aged_cost_relief_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION mr_aged_cost_relief_immutable();

CREATE FUNCTION mr_aged_cost_relief_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind='relief-offset' OR OLD.reference LIKE 'aged-cost-relief:%'
    OR (TG_OP='UPDATE' AND (NEW.kind='relief-offset' OR NEW.reference LIKE 'aged-cost-relief:%'))
    OR EXISTS(SELECT 1 FROM mr_aged_cost_reliefs WHERE credit_ledger_id=OLD.id)
    OR EXISTS(SELECT 1 FROM mr_aged_cost_relief_settlements
      WHERE OLD.id IN (settle_ledger_id,release_ledger_id,offset_ledger_id))
    OR EXISTS(SELECT 1 FROM mr_aged_cost_reliefs g
      CROSS JOIN LATERAL jsonb_array_elements(g.allocation) part
      WHERE lower(part->>'sourceLedgerId')=OLD.id::text)
    OR (OLD.kind='reserve' AND EXISTS(SELECT 1 FROM mr_aged_cost_reliefs WHERE job_id=OLD.job_id))
  THEN RAISE EXCEPTION 'aged_cost_relief_ledger_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_aged_cost_relief_ledger_immutable BEFORE UPDATE OR DELETE ON mr_ledger
  FOR EACH ROW EXECUTE FUNCTION mr_aged_cost_relief_ledger_immutable();
