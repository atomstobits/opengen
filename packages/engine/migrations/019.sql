-- C0019 proposal; root integrator alone accepts/allocates this forward migration.
CREATE TABLE mr_job_credentials (
  job_id uuid NOT NULL,
  workspace_id text NOT NULL,
  deployment_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('injected','managed','byok')),
  identity text NOT NULL CHECK(identity ~ '^(injected|managed|byok):[a-f0-9]{64}$'),
  ciphertext text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,deployment_id),
  FOREIGN KEY(job_id,workspace_id) REFERENCES mr_jobs(id,workspace_id),
  CHECK((kind='injected')=(ciphertext IS NULL))
);
CREATE TABLE mr_attempt_credentials (
  job_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK(attempt_number>0),
  workspace_id text NOT NULL,
  deployment_id text NOT NULL,
  identity text NOT NULL CHECK(identity ~ '^(injected|managed|byok):[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,attempt_number),
  FOREIGN KEY(job_id,attempt_number) REFERENCES mr_attempts(job_id,number),
  FOREIGN KEY(job_id,deployment_id) REFERENCES mr_job_credentials(job_id,deployment_id),
  FOREIGN KEY(job_id,workspace_id) REFERENCES mr_jobs(id,workspace_id)
);
ALTER TABLE mr_jobs ADD COLUMN output_evidence jsonb;
ALTER TABLE mr_jobs ADD COLUMN delivery_updated_at timestamptz;
ALTER TABLE mr_output_receipts ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE FUNCTION mr_touch_output_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER mr_output_receipt_updated BEFORE UPDATE ON mr_output_receipts
  FOR EACH ROW EXECUTE FUNCTION mr_touch_output_receipt();
CREATE INDEX mr_output_receipts_changed ON mr_output_receipts(job_id,attempt,updated_at);
