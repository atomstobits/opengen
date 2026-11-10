-- Staff-only, test-mode refund reconciliation. No issuer or live activation.
-- Historical credits, jobs, reservations and Stripe event identities stay intact.
CREATE TABLE mr_staff_refund_cases (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  order_id uuid NOT NULL,
  processor_environment_id text NOT NULL,
  processor_account_id text NOT NULL,
  livemode boolean NOT NULL CHECK (livemode=false),
  payment_intent_id text NOT NULL,
  credit_reference text NOT NULL,
  original_amount_cents integer NOT NULL CHECK(original_amount_cents BETWEEN 500 AND 100000),
  origin text NOT NULL CHECK(origin IN ('new','reconcile-existing')),
  request_version text NOT NULL CHECK(request_version='staff-refund-original-v1'),
  conversion_version text NOT NULL CHECK(conversion_version='usd-ceil-cent-v1'),
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  frozen_body jsonb NOT NULL,
  worksheet jsonb NOT NULL,
  worksheet_hash text NOT NULL CHECK(worksheet_hash ~ '^[a-f0-9]{64}$'),
  external_other_returns_cents integer NOT NULL CHECK(external_other_returns_cents>=0),
  eligible_micros bigint NOT NULL CHECK(eligible_micros>0 AND eligible_micros<=1000000000),
  cash_cents integer NOT NULL CHECK(cash_cents>0),
  principal_claim_cents integer NOT NULL CHECK(principal_claim_cents>=cash_cents AND principal_claim_cents<=original_amount_cents),
  rounding_expense_micros integer NOT NULL CHECK(rounding_expense_micros BETWEEN 0 AND 9999),
  earmark_micros bigint NOT NULL DEFAULT 0,
  outstanding_micros bigint NOT NULL DEFAULT 0,
  state text NOT NULL CHECK(state IN ('prepared','unknown','pending','succeeded','failed','review')),
  financial_state text NOT NULL DEFAULT 'none' CHECK(financial_state IN ('none','debited','released','restored')),
  review_required boolean NOT NULL DEFAULT false,
  evidence_conflict boolean NOT NULL DEFAULT false,
  ordering_review boolean NOT NULL DEFAULT false,
  refund_id text,
  charge_id text,
  dispatch_key text NOT NULL UNIQUE,
  dispatched_at timestamptz,
  latest_status text CHECK(latest_status IN ('pending','succeeded','failed')),
  latest_event_id text,
  latest_event_created bigint,
  definitive_failure_balance_returned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,reference),
  UNIQUE(processor_environment_id,refund_id),
  UNIQUE(workspace_id,id),
  UNIQUE(processor_environment_id,id),
  FOREIGN KEY(workspace_id,order_id) REFERENCES mr_payment_orders(workspace_id,id),
  FOREIGN KEY(processor_environment_id,processor_account_id,livemode)
    REFERENCES mr_billing_processor_environments(id,account_id,livemode),
  FOREIGN KEY(processor_environment_id,payment_intent_id)
    REFERENCES mr_billing_payment_ownership(processor_environment_id,payment_intent_id),
  CHECK(credit_reference='stripe-topup:'||order_id::text),
  CHECK(cash_cents::bigint*10000=eligible_micros+rounding_expense_micros),
  CHECK(cash_cents<=original_amount_cents),
  CHECK(earmark_micros IN (0,eligible_micros)),
  CHECK(outstanding_micros IN (0,eligible_micros)),
  CHECK(financial_state='none' OR earmark_micros=0),
  CHECK(origin<>'reconcile-existing' OR (refund_id IS NOT NULL AND dispatched_at IS NULL))
);
CREATE INDEX mr_staff_refund_payment ON mr_staff_refund_cases(processor_environment_id,payment_intent_id);
CREATE INDEX mr_staff_refund_earmarks ON mr_staff_refund_cases(workspace_id) WHERE earmark_micros>0;

CREATE TABLE mr_staff_refund_observations (
  processor_environment_id text NOT NULL,
  event_id text NOT NULL,
  case_id uuid NOT NULL,
  refund_id text NOT NULL,
  event_created bigint NOT NULL,
  observation_hash text NOT NULL CHECK(observation_hash ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(processor_environment_id,event_id),
  FOREIGN KEY(processor_environment_id,case_id) REFERENCES mr_staff_refund_cases(processor_environment_id,id)
);
-- Batch amount validation starts from payment-scoped cases, then reads each
-- case's observations in its exact processor namespace without per-item scans.
CREATE INDEX mr_staff_refund_observation_case_refund
  ON mr_staff_refund_observations(processor_environment_id,case_id,refund_id);
CREATE TABLE mr_staff_refund_audit (
  id uuid PRIMARY KEY,
  -- Case transactions serialize under PI/workspace locks. Use a durable ordinal,
  -- never transaction-start time or event arrival, to select approved phases.
  ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  case_id uuid NOT NULL REFERENCES mr_staff_refund_cases(id),
  action text NOT NULL CHECK(action IN ('prepare','dispatch','observe','apply-success','release-failed','restore-failed')),
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  actor jsonb NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id,reference)
);
CREATE TABLE mr_staff_refund_financial_entries (
  case_id uuid NOT NULL REFERENCES mr_staff_refund_cases(id),
  action text NOT NULL CHECK(action IN ('debit','restore')),
  ledger_id uuid NOT NULL UNIQUE REFERENCES mr_ledger(id),
  amount_micros bigint NOT NULL CHECK(amount_micros>0),
  cash_cents integer NOT NULL CHECK(cash_cents>0),
  rounding_expense_micros integer NOT NULL CHECK(rounding_expense_micros BETWEEN 0 AND 9999),
  request_version text NOT NULL CHECK(request_version='staff-refund-original-v1'),
  conversion_version text NOT NULL CHECK(conversion_version='usd-ceil-cent-v1'),
  before_available_micros bigint NOT NULL CHECK(before_available_micros>=0),
  after_available_micros bigint NOT NULL CHECK(after_available_micros>=0),
  before_reserved_micros bigint NOT NULL CHECK(before_reserved_micros>=0),
  after_reserved_micros bigint NOT NULL CHECK(after_reserved_micros=before_reserved_micros),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(case_id,action)
);
-- Operator rounding expense has no customer wallet delta. Restoration offsets it.
CREATE TABLE mr_staff_refund_expenses (
  case_id uuid NOT NULL REFERENCES mr_staff_refund_cases(id),
  action text NOT NULL CHECK(action IN ('expense','offset')),
  amount_micros integer NOT NULL CHECK(amount_micros BETWEEN 0 AND 9999),
  currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(case_id,action)
);
ALTER TABLE mr_ledger DROP CONSTRAINT mr_ledger_kind_check;
ALTER TABLE mr_ledger ADD CONSTRAINT mr_ledger_kind_check
  CHECK(kind IN ('opening','reserve','release','settle','credit','refund','refund-restore'));

CREATE FUNCTION mr_staff_refund_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind IN ('refund','refund-restore')
    OR (TG_OP='UPDATE' AND NEW.kind IN ('refund','refund-restore'))
  THEN RAISE EXCEPTION 'staff_refund_ledger_immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_staff_refund_ledger_immutable BEFORE UPDATE OR DELETE ON mr_ledger
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_ledger_immutable();

CREATE FUNCTION mr_staff_refund_financial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c mr_staff_refund_cases%ROWTYPE; l mr_ledger%ROWTYPE;
BEGIN
  SELECT * INTO c FROM mr_staff_refund_cases WHERE id=NEW.case_id;
  SELECT * INTO l FROM mr_ledger WHERE id=NEW.ledger_id;
  IF c.id IS NULL OR l.id IS NULL OR l.workspace_id<>c.workspace_id OR l.job_id IS NOT NULL
    OR NEW.amount_micros<>c.eligible_micros OR l.amount_micros<>c.eligible_micros
    OR NEW.cash_cents<>c.cash_cents OR NEW.rounding_expense_micros<>c.rounding_expense_micros
    OR NEW.request_version<>c.request_version OR NEW.conversion_version<>c.conversion_version
    OR l.reserved_delta_micros<>0
    OR l.reference IS DISTINCT FROM 'staff-refund:'||c.id::text||':'||NEW.action
    OR (NEW.action='debit' AND (l.kind<>'refund' OR l.available_delta_micros<>-c.eligible_micros))
    OR (NEW.action='restore' AND (l.kind<>'refund-restore' OR l.available_delta_micros<>c.eligible_micros
      OR NOT EXISTS(SELECT 1 FROM mr_staff_refund_financial_entries WHERE case_id=c.id AND action='debit')))
    OR NEW.receipt->>'caseId' IS DISTINCT FROM c.id::text
    OR NEW.receipt->>'orderId' IS DISTINCT FROM c.order_id::text
    OR NEW.receipt->>'refundId' IS DISTINCT FROM c.refund_id
    OR NEW.receipt->>'paidCharacter' IS DISTINCT FROM 'original-payment'
    OR NEW.receipt->>'processorEnvironmentId' IS DISTINCT FROM c.processor_environment_id
    OR NEW.receipt->>'processorAccountId' IS DISTINCT FROM c.processor_account_id
    OR NEW.receipt->>'paymentIntentId' IS DISTINCT FROM c.payment_intent_id
    OR NEW.receipt->>'requestVersion' IS DISTINCT FROM c.request_version
    OR NEW.receipt->>'conversionVersion' IS DISTINCT FROM c.conversion_version
    OR NEW.receipt->>'eligibleMicros' IS DISTINCT FROM c.eligible_micros::text
    OR NEW.receipt->>'cashCents' IS DISTINCT FROM c.cash_cents::text
    OR NEW.receipt->>'roundingExpenseMicros' IS DISTINCT FROM c.rounding_expense_micros::text
    OR NEW.receipt->'before'->>'availableMicros' IS DISTINCT FROM NEW.before_available_micros::text
    OR NEW.receipt->'after'->>'availableMicros' IS DISTINCT FROM NEW.after_available_micros::text
    OR NEW.receipt->'before'->>'reservedMicros' IS DISTINCT FROM NEW.before_reserved_micros::text
    OR NEW.receipt->'after'->>'reservedMicros' IS DISTINCT FROM NEW.after_reserved_micros::text
    OR NEW.after_available_micros-NEW.before_available_micros<>l.available_delta_micros
    OR NOT EXISTS(SELECT 1 FROM mr_workspaces w WHERE w.id=c.workspace_id
      AND w.available_micros=NEW.after_available_micros AND w.reserved_micros=NEW.after_reserved_micros)
    OR NOT EXISTS(SELECT 1 FROM mr_billing_payment_ownership p
      JOIN mr_payment_orders o ON o.id=c.order_id AND o.workspace_id=c.workspace_id
      JOIN mr_ledger original ON original.workspace_id=c.workspace_id AND original.reference=c.credit_reference
      WHERE p.processor_environment_id=c.processor_environment_id AND p.payment_intent_id=c.payment_intent_id
        AND p.kind='manual' AND p.local_id=c.order_id AND p.workspace_id=c.workspace_id
        AND p.credit_reference=c.credit_reference AND p.amount_cents=c.original_amount_cents
        AND p.livemode=false AND o.livemode=false AND o.credited_at IS NOT NULL
        AND o.processor_environment_id=c.processor_environment_id AND o.processor_account_id=c.processor_account_id
        AND o.payment_intent_id=c.payment_intent_id AND o.amount_cents=c.original_amount_cents
        AND original.kind='credit' AND original.amount_micros=c.original_amount_cents::bigint*10000
        AND original.available_delta_micros=original.amount_micros AND original.reserved_delta_micros=0)
    OR NOT EXISTS(SELECT 1 FROM mr_staff_refund_observations o
      WHERE o.case_id=c.id AND o.processor_environment_id=c.processor_environment_id
        AND o.event_id=c.latest_event_id AND o.refund_id=c.refund_id
        AND o.evidence->>'paymentIntentId'=c.payment_intent_id
        AND o.evidence->>'amountCents'=c.cash_cents::text
        AND ((NEW.action='debit' AND o.evidence->>'status'='succeeded')
          OR (NEW.action='restore' AND o.evidence->>'status'='failed'
            AND o.evidence->>'definitiveFailureBalanceReturned'='true')))
  THEN RAISE EXCEPTION 'staff_refund_financial_identity'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_staff_refund_financial_guard BEFORE INSERT ON mr_staff_refund_financial_entries
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_financial_guard();
CREATE FUNCTION mr_staff_refund_expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mr_staff_refund_cases c
    JOIN mr_staff_refund_financial_entries f ON f.case_id=c.id
      AND f.action=(CASE NEW.action WHEN 'expense' THEN 'debit' ELSE 'restore' END)
    WHERE c.id=NEW.case_id AND c.rounding_expense_micros=NEW.amount_micros)
  THEN RAISE EXCEPTION 'staff_refund_expense_identity'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_staff_refund_expense_guard BEFORE INSERT ON mr_staff_refund_expenses
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_expense_guard();

CREATE FUNCTION mr_staff_refund_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff_refund_immutable';
END $$;
CREATE TRIGGER mr_staff_refund_observations_immutable BEFORE UPDATE OR DELETE ON mr_staff_refund_observations
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_immutable();
CREATE TRIGGER mr_staff_refund_audit_immutable BEFORE UPDATE OR DELETE ON mr_staff_refund_audit
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_immutable();
CREATE TRIGGER mr_staff_refund_financial_immutable BEFORE UPDATE OR DELETE ON mr_staff_refund_financial_entries
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_immutable();
CREATE TRIGGER mr_staff_refund_expenses_immutable BEFORE UPDATE OR DELETE ON mr_staff_refund_expenses
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_immutable();
CREATE FUNCTION mr_staff_refund_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'staff_refund_immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['earmark_micros','outstanding_micros','state','financial_state','review_required',
      'refund_id','charge_id','dispatched_at','latest_status','latest_event_id','latest_event_created',
      'definitive_failure_balance_returned','evidence_conflict','ordering_review','principal_claim_cents','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['earmark_micros','outstanding_micros','state','financial_state','review_required',
      'refund_id','charge_id','dispatched_at','latest_status','latest_event_id','latest_event_created',
      'definitive_failure_balance_returned','evidence_conflict','ordering_review','principal_claim_cents','updated_at'])
     OR NEW.principal_claim_cents<OLD.principal_claim_cents
     OR (OLD.refund_id IS NOT NULL AND NEW.refund_id IS DISTINCT FROM OLD.refund_id)
     OR (OLD.charge_id IS NOT NULL AND NEW.charge_id IS DISTINCT FROM OLD.charge_id)
     OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
  THEN RAISE EXCEPTION 'staff_refund_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_staff_refund_case_guard BEFORE UPDATE OR DELETE ON mr_staff_refund_cases
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_case_guard();

-- Keep event_id as the historical hold identity and preserve resolution FKs.
-- Old Stripe writers omit the new columns; the trigger qualifies their real event FK.
ALTER TABLE mr_billing_holds DROP CONSTRAINT mr_billing_holds_event_id_fkey;
ALTER TABLE mr_billing_holds ADD COLUMN source_kind text NOT NULL DEFAULT 'stripe'
  CHECK(source_kind IN ('stripe','staff-refund'));
ALTER TABLE mr_billing_holds ADD COLUMN stripe_event_id text REFERENCES mr_payment_events(id);
ALTER TABLE mr_billing_holds ADD COLUMN staff_refund_case_id uuid REFERENCES mr_staff_refund_cases(id);
UPDATE mr_billing_holds SET stripe_event_id=event_id;
ALTER TABLE mr_billing_holds ADD CONSTRAINT mr_billing_hold_source_identity CHECK (
  (source_kind='stripe' AND stripe_event_id IS NOT NULL AND stripe_event_id=event_id AND staff_refund_case_id IS NULL
    AND event_id NOT LIKE 'staff-refund:%') OR
  (source_kind='staff-refund' AND stripe_event_id IS NULL AND staff_refund_case_id IS NOT NULL
    AND event_id LIKE 'staff-refund:'||staff_refund_case_id::text||':%')
);
CREATE FUNCTION mr_staff_refund_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c mr_staff_refund_cases%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.source_kind='staff-refund' THEN RAISE EXCEPTION 'staff_refund_hold_immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.stripe_event_id IS DISTINCT FROM OLD.stripe_event_id
    OR NEW.staff_refund_case_id IS DISTINCT FROM OLD.staff_refund_case_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.recharge_attempt_id IS DISTINCT FROM OLD.recharge_attempt_id
    OR (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
      OR NEW.resolution_reference IS DISTINCT FROM OLD.resolution_reference)))
  THEN RAISE EXCEPTION 'staff_refund_hold_immutable'; END IF;
  IF NEW.source_kind='stripe' THEN
    IF NEW.stripe_event_id IS NULL THEN NEW.stripe_event_id=NEW.event_id; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM mr_staff_refund_cases WHERE id=NEW.staff_refund_case_id;
  IF NOT FOUND OR NEW.workspace_id<>c.workspace_id OR NEW.order_id IS DISTINCT FROM c.order_id
    OR NEW.recharge_attempt_id IS NOT NULL
    OR NEW.event_id !~ ('^staff-refund:'||c.id::text||':[a-f0-9-]{36}$')
  THEN RAISE EXCEPTION 'staff_refund_hold_identity'; END IF;
  IF TG_OP='UPDATE' AND (NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.staff_refund_case_id IS DISTINCT FROM OLD.staff_refund_case_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
      OR NEW.resolution_reference IS DISTINCT FROM OLD.resolution_reference)))
  THEN RAISE EXCEPTION 'staff_refund_hold_immutable'; END IF;
  IF NEW.resolved_at IS NOT NULL AND (TG_OP='INSERT' OR OLD.resolved_at IS NULL) THEN
    IF c.earmark_micros<>0 OR c.outstanding_micros<>0 OR c.review_required OR c.evidence_conflict OR c.ordering_review
      OR NOT ((c.financial_state='debited' AND c.latest_status='succeeded')
        OR (c.financial_state IN ('released','restored') AND c.latest_status='failed'
          AND c.definitive_failure_balance_returned))
    THEN RAISE EXCEPTION 'staff_refund_active'; END IF;
    IF NOT EXISTS(SELECT 1 FROM mr_staff_refund_observations o
      WHERE o.case_id=c.id AND o.event_id=c.latest_event_id
        AND o.processor_environment_id=c.processor_environment_id
        AND o.evidence->>'refundId'=c.refund_id
        AND o.evidence->>'paymentIntentId'=c.payment_intent_id
        AND o.evidence->>'status'=c.latest_status
        AND o.evidence->>'amountCents'=c.cash_cents::text
        AND (c.latest_status='succeeded' OR o.evidence->>'definitiveFailureBalanceReturned'='true'))
    THEN RAISE EXCEPTION 'staff_refund_active'; END IF;
    IF c.financial_state IN ('debited','restored') AND NOT EXISTS(
      SELECT 1 FROM mr_staff_refund_financial_entries f JOIN mr_ledger l ON l.id=f.ledger_id
      WHERE f.case_id=c.id AND f.action='debit' AND l.kind='refund'
        AND l.workspace_id=c.workspace_id AND l.amount_micros=c.eligible_micros
        AND l.available_delta_micros=-c.eligible_micros AND l.reserved_delta_micros=0
        AND l.reference='staff-refund:'||c.id::text||':debit')
    THEN RAISE EXCEPTION 'staff_refund_active'; END IF;
    IF c.financial_state='restored' AND NOT EXISTS(
      SELECT 1 FROM mr_staff_refund_financial_entries f JOIN mr_ledger l ON l.id=f.ledger_id
      WHERE f.case_id=c.id AND f.action='restore' AND l.kind='refund-restore'
        AND l.workspace_id=c.workspace_id AND l.amount_micros=c.eligible_micros
        AND l.available_delta_micros=c.eligible_micros AND l.reserved_delta_micros=0
        AND l.reference='staff-refund:'||c.id::text||':restore')
    THEN RAISE EXCEPTION 'staff_refund_active'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_staff_refund_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON mr_billing_holds
  FOR EACH ROW EXECUTE FUNCTION mr_staff_refund_hold_guard();
