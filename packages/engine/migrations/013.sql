-- User-reviewed support reports only; no automatic request/log/media capture.
CREATE TABLE mr_feedback (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  kind text NOT NULL CHECK (kind IN ('feedback','catalog-request')),
  category text NOT NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 8 AND 1000),
  model_id text,
  route_id text,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mr_feedback_workspace_created ON mr_feedback(workspace_id,created_at DESC);
