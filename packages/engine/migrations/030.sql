-- Core-allocated mode-bound staff refund support; no runtime activation or issuer.
-- Preserve001–029 bytes and all existing rows, keys, versions, FKs and barriers.
-- The mode-agnostic hold/case/expense/immutability guards remain unchanged.
ALTER TABLE mr_staff_refund_cases
  DROP CONSTRAINT mr_staff_refund_cases_livemode_check;

CREATE OR REPLACE FUNCTION mr_staff_refund_financial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR NEW.receipt->'livemode' IS DISTINCT FROM to_jsonb(c.livemode)
    OR NEW.receipt->'processorAccountId' IS DISTINCT FROM to_jsonb(c.processor_account_id)
    OR NEW.receipt->'processorEnvironmentId' IS DISTINCT FROM to_jsonb(c.processor_environment_id)
    OR NEW.receipt->'creditReference' IS DISTINCT FROM to_jsonb(c.credit_reference)
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
    OR NOT EXISTS(SELECT 1 FROM mr_billing_processor_environments e
      JOIN mr_billing_payment_ownership p ON p.processor_environment_id=e.id AND p.livemode=e.livemode
      JOIN mr_payment_orders original_order ON original_order.id=c.order_id AND original_order.workspace_id=c.workspace_id
      JOIN mr_ledger original_credit ON original_credit.workspace_id=c.workspace_id AND original_credit.reference=c.credit_reference
      WHERE e.id=c.processor_environment_id AND e.account_id=c.processor_account_id AND e.livemode=c.livemode
        AND p.payment_intent_id=c.payment_intent_id AND p.kind='manual' AND p.local_id=c.order_id
        AND p.workspace_id=c.workspace_id AND p.credit_reference=c.credit_reference
        AND p.amount_cents=c.original_amount_cents AND p.currency='USD'
        AND original_order.processor_environment_id=e.id AND original_order.processor_account_id=e.account_id
        AND original_order.livemode=c.livemode AND original_order.currency='USD'
        AND original_order.payment_intent_id=c.payment_intent_id AND original_order.amount_cents=c.original_amount_cents
        AND original_order.status='credited' AND original_order.credited_at IS NOT NULL
        AND original_credit.kind='credit' AND original_credit.job_id IS NULL
        AND original_credit.amount_micros=c.original_amount_cents::bigint*10000
        AND original_credit.available_delta_micros=original_credit.amount_micros
        AND original_credit.reserved_delta_micros=0)
    OR NOT EXISTS(SELECT 1 FROM mr_staff_refund_observations o
      WHERE o.case_id=c.id AND o.processor_environment_id=c.processor_environment_id
        AND o.event_id=c.latest_event_id AND o.refund_id=c.refund_id
        AND o.evidence->'kind'='"refund"'::jsonb
        AND o.evidence->'workspaceId'=to_jsonb(c.workspace_id)
        AND o.evidence->'orderId'=to_jsonb(c.order_id::text)
        AND o.evidence->'processorEnvironmentId'=to_jsonb(c.processor_environment_id)
        AND o.evidence->'processorAccountId'=to_jsonb(c.processor_account_id)
        AND o.evidence->'livemode'=to_jsonb(c.livemode)
        AND o.evidence->'currency'='"USD"'::jsonb
        AND o.evidence->'refundId'=to_jsonb(c.refund_id)
        AND o.evidence->'chargeId'=to_jsonb(c.charge_id)
        AND o.evidence->'eventId'=to_jsonb(o.event_id)
        AND o.evidence->'eventCreated'=to_jsonb(o.event_created)
        AND o.evidence->'paymentIntentId'=to_jsonb(c.payment_intent_id)
        AND o.evidence->'amountCents'=to_jsonb(c.cash_cents)
        AND o.evidence->>'paymentIntentId'=c.payment_intent_id
        AND o.evidence->>'amountCents'=c.cash_cents::text
        AND ((NEW.action='debit' AND o.evidence->>'status'='succeeded')
          OR (NEW.action='restore' AND o.evidence->>'status'='failed'
            AND o.evidence->'definitiveFailureBalanceReturned'='true'::jsonb)))
  THEN RAISE EXCEPTION 'staff_refund_financial_identity'; END IF;
  RETURN NEW;
END $$;
