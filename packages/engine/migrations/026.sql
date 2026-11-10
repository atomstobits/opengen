CREATE TABLE mr_comparison_runs (
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  id uuid NOT NULL,
  quote jsonb NOT NULL,
  child_key_nonce uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  admitted_at timestamptz,
  first_job_id uuid,
  second_job_id uuid,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,first_job_id) REFERENCES mr_jobs(workspace_id,id),
  FOREIGN KEY (workspace_id,second_job_id) REFERENCES mr_jobs(workspace_id,id),
  CHECK (
    (admitted_at IS NULL AND first_job_id IS NULL AND second_job_id IS NULL)
    OR (admitted_at IS NOT NULL AND first_job_id IS NOT NULL AND second_job_id IS NOT NULL
        AND first_job_id <> second_job_id)
  )
);
CREATE INDEX mr_comparison_recent ON mr_comparison_runs(workspace_id,admitted_at DESC,id)
  WHERE admitted_at IS NOT NULL;
CREATE INDEX mr_comparison_expiry ON mr_comparison_runs(expires_at)
  WHERE admitted_at IS NULL;
