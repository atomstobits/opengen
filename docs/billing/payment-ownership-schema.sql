-- Unallocated funding-ownership fragment. Apply after processor registry and
-- recharge attempt tables. Existing manual rows and event namespaces stay NULL.
ALTER TABLE mr_payment_orders
  ADD COLUMN processor_environment_id text,
  ADD COLUMN processor_account_id text,
  ADD CONSTRAINT mr_manual_payment_processor_identity
    CHECK ((processor_environment_id IS NULL) = (processor_account_id IS NULL)),
  ADD CONSTRAINT mr_manual_payment_processor_env_fk
    FOREIGN KEY (processor_environment_id,processor_account_id,livemode)
    REFERENCES mr_billing_processor_environments(id,account_id,livemode),
  ADD CONSTRAINT mr_manual_payment_tenant_identity UNIQUE (workspace_id,id);
ALTER TABLE mr_payment_events
  ADD COLUMN processor_environment_id text REFERENCES mr_billing_processor_environments(id);
ALTER TABLE mr_billing_recharge_attempts
  ADD CONSTRAINT mr_automatic_payment_tenant_identity UNIQUE (workspace_id,id);

CREATE TABLE mr_billing_payment_ownership (
  processor_environment_id text NOT NULL,
  livemode boolean NOT NULL,
  payment_intent_id text NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,240}$'),
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  kind text NOT NULL CHECK (kind IN ('manual','automatic')),
  local_id uuid NOT NULL,
  manual_order_id uuid,
  recharge_attempt_id uuid,
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 500 AND 100000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  credit_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (processor_environment_id,payment_intent_id),
  UNIQUE (kind,local_id),
  UNIQUE (workspace_id,credit_reference),
  FOREIGN KEY (processor_environment_id,livemode)
    REFERENCES mr_billing_processor_environments(id,livemode),
  FOREIGN KEY (workspace_id,manual_order_id)
    REFERENCES mr_payment_orders(workspace_id,id),
  FOREIGN KEY (workspace_id,recharge_attempt_id)
    REFERENCES mr_billing_recharge_attempts(workspace_id,id),
  CHECK ((kind='manual' AND manual_order_id IS NOT NULL AND manual_order_id=local_id AND recharge_attempt_id IS NULL)
      OR (kind='automatic' AND recharge_attempt_id IS NOT NULL AND recharge_attempt_id=local_id AND manual_order_id IS NULL)),
  CHECK (credit_reference=(CASE kind WHEN 'manual' THEN 'stripe-topup:' ELSE 'stripe-recharge:' END)||local_id::text)
);
