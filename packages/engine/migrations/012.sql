-- Optional customer payments. Never alter or delete historical credit entries.
CREATE TABLE mr_payment_orders (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  client_key text NOT NULL CHECK (length(client_key) BETWEEN 8 AND 128),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 500 AND 100000),
  credit_micros bigint NOT NULL CHECK (credit_micros = amount_cents::bigint * 10000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  livemode boolean NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','checkout_pending','checkout_open','payment_pending','payment_failed','expired','credited','review')),
  stripe_idempotency_key text NOT NULL UNIQUE,
  integration_identifier text NOT NULL,
  session_id text UNIQUE,
  payment_intent_id text UNIQUE,
  checkout_url text,
  checkout_started_at timestamptz,
  checkout_expires_at timestamptz,
  checkout_lease_until timestamptz,
  checkout_next_request_at timestamptz,
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, client_key),
  CHECK ((checkout_started_at IS NULL) = (checkout_expires_at IS NULL)),
  CHECK ((status = 'credited') = (credited_at IS NOT NULL))
);
CREATE INDEX mr_payment_orders_history ON mr_payment_orders(workspace_id,created_at DESC,id DESC);

-- Minimized verified event journal: no card/customer objects or raw webhook bodies.
CREATE TABLE mr_payment_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  object_id text NOT NULL,
  payment_intent_id text,
  livemode boolean NOT NULL,
  order_id uuid REFERENCES mr_payment_orders(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processed','ignored','rejected')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX mr_payment_events_unresolved ON mr_payment_events(state,created_at);
CREATE INDEX mr_payment_events_intent ON mr_payment_events(payment_intent_id);

CREATE TABLE mr_billing_holds (
  event_id text PRIMARY KEY REFERENCES mr_payment_events(id),
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  order_id uuid NOT NULL REFERENCES mr_payment_orders(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_reference text,
  CHECK ((resolved_at IS NULL) = (resolution_reference IS NULL))
);
CREATE INDEX mr_billing_holds_active ON mr_billing_holds(workspace_id) WHERE resolved_at IS NULL;

-- Fixed-size counters: one installation row, and fields on existing workspace
-- rows. Never create a counter row per client key, order or time window.
ALTER TABLE mr_workspaces
  ADD COLUMN payment_order_window bigint NOT NULL DEFAULT 0 CHECK (payment_order_window >= 0),
  ADD COLUMN payment_order_count integer NOT NULL DEFAULT 0 CHECK (payment_order_count BETWEEN 0 AND 10),
  ADD COLUMN payment_checkout_window bigint NOT NULL DEFAULT 0 CHECK (payment_checkout_window >= 0),
  ADD COLUMN payment_checkout_count integer NOT NULL DEFAULT 0 CHECK (payment_checkout_count BETWEEN 0 AND 30);
CREATE TABLE mr_payment_rate_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  payment_order_window bigint NOT NULL DEFAULT 0 CHECK (payment_order_window >= 0),
  payment_order_count integer NOT NULL DEFAULT 0 CHECK (payment_order_count BETWEEN 0 AND 1000),
  payment_checkout_window bigint NOT NULL DEFAULT 0 CHECK (payment_checkout_window >= 0),
  payment_checkout_count integer NOT NULL DEFAULT 0 CHECK (payment_checkout_count BETWEEN 0 AND 3000)
);
INSERT INTO mr_payment_rate_limits(singleton) VALUES(true);
