CREATE TABLE IF NOT EXISTS mr_webhook_subscriptions (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  name text NOT NULL,
  url text NOT NULL,
  event_types jsonb NOT NULL,
  secret_ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mr_webhook_workspace ON mr_webhook_subscriptions(workspace_id);
CREATE TABLE IF NOT EXISTS mr_events (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  type text NOT NULL,
  dedupe_key text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,type,dedupe_key)
);
CREATE TABLE IF NOT EXISTS mr_webhook_deliveries (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES mr_events(id),
  subscription_id uuid NOT NULL REFERENCES mr_webhook_subscriptions(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivering','delivered','dead','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_status_code integer,
  last_error_code text,
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,subscription_id)
);
CREATE INDEX IF NOT EXISTS mr_webhook_pending ON mr_webhook_deliveries(status,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS mr_alert_settings (
  workspace_id text PRIMARY KEY REFERENCES mr_workspaces(id),
  enabled boolean NOT NULL DEFAULT true,
  low_balance_micros bigint CHECK(low_balance_micros>=0),
  spending_limit_micros bigint CHECK(spending_limit_micros>=0),
  key_expiry_hours integer CHECK(key_expiry_hours BETWEEN 1 AND 720),
  webhook_failures boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS mr_alert_state (
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  alert_key text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  change_count integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,alert_key)
);
