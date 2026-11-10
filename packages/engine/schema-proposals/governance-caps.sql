-- Unnumbered C5 proposal. The integrator owns migration016 and its manifest.
-- No attribution is guessed for old jobs. Coverage begins at this cutover,
-- including keys that have not yet configured a cap.
ALTER TABLE mr_api_keys ADD COLUMN IF NOT EXISTS monthly_cap_micros bigint
  CHECK (monthly_cap_micros >= 0 AND monthly_cap_micros <= 9007199254740991);
ALTER TABLE mr_api_keys ADD COLUMN IF NOT EXISTS cap_coverage_started_at timestamptz
  NOT NULL DEFAULT clock_timestamp();

CREATE TABLE IF NOT EXISTS mr_key_months (
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  key_id uuid NOT NULL REFERENCES mr_api_keys(id),
  admission_month date NOT NULL CHECK (EXTRACT(DAY FROM admission_month)=1),
  gross_debit_micros bigint NOT NULL DEFAULT 0 CHECK (gross_debit_micros >= 0),
  held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
  PRIMARY KEY(workspace_id,key_id,admission_month)
);
CREATE TABLE IF NOT EXISTS mr_key_reservations (
  job_id uuid PRIMARY KEY REFERENCES mr_jobs(id),
  workspace_id text NOT NULL,
  key_id uuid NOT NULL,
  admission_month date NOT NULL,
  reserved_micros bigint NOT NULL CHECK (reserved_micros >= 0),
  settled_micros bigint CHECK (settled_micros >= 0 AND settled_micros <= reserved_micros),
  admitted_at timestamptz NOT NULL,
  settled_at timestamptz,
  FOREIGN KEY(workspace_id,key_id,admission_month)
    REFERENCES mr_key_months(workspace_id,key_id,admission_month)
);
CREATE INDEX IF NOT EXISTS mr_key_reservations_subject
  ON mr_key_reservations(workspace_id,key_id,admission_month);
