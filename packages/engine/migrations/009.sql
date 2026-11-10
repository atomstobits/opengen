CREATE TABLE IF NOT EXISTS mr_reconciliations (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  job_id uuid NOT NULL REFERENCES mr_jobs(id),
  reference text NOT NULL,
  request_hash text NOT NULL,
  action text NOT NULL CHECK(action IN ('resume','reject','settle')),
  note text NOT NULL,
  evidence_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,job_id,reference)
);
