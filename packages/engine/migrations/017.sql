-- C0-reviewed forward migration; legacy unknowns remain explicit.
-- C6 unnumbered proposal. Integration owns allocation/loader/upgrade qualification.
-- No legacy backfill: absent observations and old queue deadlines stay NULL.
ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS execution_progress jsonb;
ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS execution_error jsonb;
ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS execution_timings jsonb;
ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS queue_start_deadline_at timestamptz;

CREATE TABLE IF NOT EXISTS mr_execution_pools (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('workspace','provider')),
  max_active integer NOT NULL CHECK (max_active BETWEEN 1 AND 1000000),
  max_queued integer NOT NULL CHECK (max_queued BETWEEN 0 AND 1000000)
);

-- Occupancy deliberately has no lease_until. A worker lease is NOT provider acceptance evidence.
CREATE TABLE IF NOT EXISTS mr_dispatch_slots (
  job_id uuid NOT NULL REFERENCES mr_jobs(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  workspace_pool_id text NOT NULL REFERENCES mr_execution_pools(id),
  provider_pool_id text NOT NULL REFERENCES mr_execution_pools(id),
  state text NOT NULL CHECK (state IN ('queued','occupied','unknown','released','expired')),
  start_deadline_at timestamptz,
  submission_intent_at timestamptz,
  released_at timestamptz,
  release_evidence text CHECK (release_evidence IN ('confirmed_terminal','explicit_rejection','operator_reconciled','never_submitted_deadline')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id,attempt_number),
  CHECK (workspace_pool_id <> provider_pool_id),
  CHECK ((state IN ('released','expired')) = (released_at IS NOT NULL)),
  CHECK ((state IN ('released','expired')) = (release_evidence IS NOT NULL)),
  CHECK (state NOT IN ('occupied','unknown') OR submission_intent_at IS NOT NULL),
  CHECK (state <> 'expired' OR submission_intent_at IS NULL)
);
CREATE INDEX IF NOT EXISTS mr_dispatch_workspace_active ON mr_dispatch_slots(workspace_pool_id,state);
CREATE INDEX IF NOT EXISTS mr_dispatch_provider_active ON mr_dispatch_slots(provider_pool_id,state);
CREATE INDEX IF NOT EXISTS mr_dispatch_deadline ON mr_dispatch_slots(start_deadline_at) WHERE state='queued';
