-- Unnumbered C5 authority proposal; integrator allocates migration016.
-- Versions reject requests authenticated before a secret rotation and prepared afterward.
ALTER TABLE mr_api_keys ADD COLUMN IF NOT EXISTS secret_version integer NOT NULL DEFAULT 1
  CHECK (secret_version > 0);
ALTER TABLE mr_api_keys ADD COLUMN IF NOT EXISTS rotated_at timestamptz;
ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS attribution jsonb;
ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS effective_policy jsonb;
-- NULL attribution/effective_policy on legacy rows is intentional. Never infer a source key.
CREATE INDEX IF NOT EXISTS mr_mcp_oauth_grants_source
  ON mr_mcp_oauth_grants(workspace_id,source_key_id) WHERE source_key_id IS NOT NULL;
