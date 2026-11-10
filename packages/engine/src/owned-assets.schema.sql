-- Unnumbered C2/C4 schema proposal; integration owns migration015 and the loader.
CREATE UNIQUE INDEX IF NOT EXISTS mr_jobs_workspace_id_unique ON mr_jobs(workspace_id,id);
CREATE TABLE IF NOT EXISTS mr_input_preparations (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  canonical_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('processing','ready','failed','admitted')),
  input jsonb,
  manifest jsonb NOT NULL DEFAULT '[]',
  owner_token uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  job_id uuid,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,idempotency_key),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,job_id) REFERENCES mr_jobs(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS mr_owned_assets (
  asset_key text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  state text NOT NULL CHECK (state IN ('prepared','uploading','processing','ready','failed','expired','deleted')),
  media_type text,
  expected_media_type text,
  expected_size bigint,
  byte_length bigint,
  sha256 text,
  upload_key text,
  multipart_session jsonb,
  upload_expires_at timestamptz,
  staging_purged_at timestamptz,
  preparation_id uuid,
  preparation_path text,
  source_url_hash text,
  import_started boolean NOT NULL DEFAULT false,
  write_owner_token uuid,
  write_lease_until timestamptz,
  content_revision bigint NOT NULL DEFAULT 0,
  source_job_id uuid,
  source_output_index integer,
  reuse_idempotency_key text,
  expires_at timestamptz,
  delete_requested_at timestamptz,
  purged_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(preparation_id,preparation_path),
  UNIQUE(preparation_id,source_url_hash),
  UNIQUE(workspace_id,reuse_idempotency_key),
  UNIQUE(workspace_id,asset_key),
  FOREIGN KEY(workspace_id,preparation_id) REFERENCES mr_input_preparations(workspace_id,id),
  FOREIGN KEY(workspace_id,source_job_id) REFERENCES mr_jobs(workspace_id,id),
  CHECK (state <> 'ready' OR (media_type IS NOT NULL AND byte_length IS NOT NULL AND byte_length > 0 AND sha256 IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX IF NOT EXISTS mr_owned_assets_cleanup ON mr_owned_assets(state,expires_at,delete_requested_at);

CREATE TABLE IF NOT EXISTS mr_asset_pins (
  asset_key text NOT NULL,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_key,job_id),
  FOREIGN KEY(workspace_id,asset_key) REFERENCES mr_owned_assets(workspace_id,asset_key),
  FOREIGN KEY(workspace_id,job_id) REFERENCES mr_jobs(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS mr_asset_pins_job ON mr_asset_pins(workspace_id,job_id);
