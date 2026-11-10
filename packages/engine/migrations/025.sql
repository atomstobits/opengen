-- Durable recharge and canonical PaymentIntent ownership.
CREATE TABLE mr_billing_recharge_state (
  workspace_id text PRIMARY KEY REFERENCES mr_workspaces(id),
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  next_evaluation_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mr_billing_recharge_attempts (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  policy_version integer NOT NULL CHECK(policy_version > 0),
  policy_snapshot jsonb NOT NULL,
  mandate_id uuid NOT NULL,
  customer_id text NOT NULL,
  payment_method_id text NOT NULL,
  livemode boolean NOT NULL,
  processor_environment_id text NOT NULL,
  processor_account_id text NOT NULL,
  amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 500 AND 100000),
  admission_month date NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','submitting','unknown','processing','requires_authentication','review','succeeded','failed','cancelled')),
  stripe_idempotency_key text NOT NULL UNIQUE,
  request_version text NOT NULL DEFAULT 'recharge_pi_v1' CHECK(request_version='recharge_pi_v1'),
  api_version text NOT NULL DEFAULT '2026-10-28.endive' CHECK(api_version='2026-10-28.endive'),
  payment_intent_id text,
  external_started_at timestamptz,
  next_request_at timestamptz,
  credited_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (processor_environment_id,payment_intent_id),
  FOREIGN KEY (processor_environment_id,processor_account_id,livemode)
    REFERENCES mr_billing_processor_environments(id,account_id,livemode),
  FOREIGN KEY (workspace_id,processor_environment_id,customer_id,mandate_id)
    REFERENCES mr_billing_mandates(workspace_id,processor_environment_id,customer_id,id),
  CHECK ((status='succeeded') = (credited_at IS NOT NULL))
);
CREATE UNIQUE INDEX mr_billing_recharge_inflight ON mr_billing_recharge_attempts(workspace_id)
 WHERE status IN ('queued','submitting','unknown','processing','requires_authentication','review');
CREATE INDEX mr_billing_recharge_month ON mr_billing_recharge_attempts(workspace_id,admission_month,status);
CREATE INDEX mr_billing_recharge_due ON mr_billing_recharge_attempts(status,next_request_at,created_at);
CREATE TABLE mr_billing_recharge_events (
  id text PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES mr_billing_recharge_attempts(id),
  type text NOT NULL,
  object_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mr_billing_recharge_resolutions (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES mr_billing_recharge_attempts(id),
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 200),
  note text NOT NULL CHECK(length(note) BETWEEN 1 AND 2000),
  evidence_url text NOT NULL,
  action text NOT NULL CHECK(action IN ('bind','confirmed-unpaid')),
  actor jsonb NOT NULL,
  payment_intent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(attempt_id,reference)
);

-- Reuse the existing spending hold queue for automatic funding risk.
ALTER TABLE mr_billing_holds ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE mr_billing_holds ADD COLUMN recharge_attempt_id uuid REFERENCES mr_billing_recharge_attempts(id);
ALTER TABLE mr_billing_holds ADD CONSTRAINT mr_billing_hold_payment_identity
 CHECK ((order_id IS NOT NULL)::integer + (recharge_attempt_id IS NOT NULL)::integer = 1);
CREATE TABLE mr_billing_hold_resolutions (
  id uuid PRIMARY KEY,
  event_id text NOT NULL REFERENCES mr_billing_holds(event_id),
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 200),
  note text NOT NULL CHECK(length(note) BETWEEN 1 AND 2000),
  evidence_url text NOT NULL,
  actor jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,reference)
);

-- Existing manual orders and event namespaces retain null processor bindings.
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
