-- B4 fragment, not allocated migration. Core reviewer assigns forward slot.
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
