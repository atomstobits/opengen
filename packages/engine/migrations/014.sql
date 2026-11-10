-- C0-reviewed forward migration; legacy unknowns remain explicit.
-- Unnumbered draft; integration owns reserved migration014 and loader.
CREATE UNIQUE INDEX mr_jobs_id_workspace_delivery ON mr_jobs(id,workspace_id);
CREATE TABLE mr_output_receipts (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  job_id uuid NOT NULL REFERENCES mr_jobs(id),
  attempt integer NOT NULL CHECK(attempt > 0),
  route_id text NOT NULL,
  deployment_id text NOT NULL,
  upstream_id text,
  provider_connection_id text CHECK(length(provider_connection_id)<=200),
  slot integer NOT NULL CHECK(slot BETWEEN 0 AND 19),
  kind text NOT NULL CHECK(kind IN ('url','inline','owned')),
  media_type text NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/webp','video/mp4')),
  source_url text CHECK(length(source_url)<=8192),
  source_key text,
  inline_bytes bytea CHECK(octet_length(inline_bytes)<=104857600),
  source_expires_at timestamptz,
  refreshable boolean NOT NULL DEFAULT false,
  object_key text NOT NULL UNIQUE,
  source_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','available','failed','expired')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 21),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  sha256 text,
  byte_length integer,
  evidence jsonb,
  FOREIGN KEY(job_id,workspace_id) REFERENCES mr_jobs(id,workspace_id),
  UNIQUE(job_id,attempt,slot)
);
CREATE INDEX mr_output_receipts_work ON mr_output_receipts(state,next_attempt_at,lease_until);
CREATE INDEX mr_output_receipts_workspace ON mr_output_receipts(workspace_id,job_id);
