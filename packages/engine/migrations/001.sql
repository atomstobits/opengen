CREATE TABLE IF NOT EXISTS mr_workspaces (
  id text PRIMARY KEY,
  available_micros bigint NOT NULL CHECK (available_micros >= 0),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mr_jobs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  input jsonb NOT NULL,
  route_snapshot jsonb NOT NULL,
  deployment_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'submitting', 'running', 'submission-unknown', 'succeeded', 'failed', 'cancelled')),
  upstream_id text,
  outputs jsonb NOT NULL DEFAULT '[]',
  error text,
  failure_category text,
  reserved_micros bigint NOT NULL CHECK (reserved_micros >= 0),
  settled_micros bigint,
  upstream_cost_micros bigint,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS mr_jobs_work ON mr_jobs(status, next_poll_at, lease_until);
CREATE INDEX IF NOT EXISTS mr_jobs_workspace ON mr_jobs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mr_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES mr_jobs(id),
  number integer NOT NULL,
  route_id text NOT NULL,
  deployment_id text NOT NULL,
  state text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(job_id, number)
);

CREATE TABLE IF NOT EXISTS mr_ledger (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  job_id uuid REFERENCES mr_jobs(id),
  kind text NOT NULL CHECK (kind IN ('opening', 'reserve', 'release', 'settle')),
  amount_micros bigint NOT NULL,
  available_delta_micros bigint NOT NULL,
  reserved_delta_micros bigint NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mr_ledger_job_kind ON mr_ledger(job_id, kind) WHERE job_id IS NOT NULL;
