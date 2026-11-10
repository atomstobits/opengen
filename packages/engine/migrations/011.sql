CREATE TABLE IF NOT EXISTS mr_mcp_oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mr_mcp_oauth_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);
CREATE TABLE IF NOT EXISTS mr_mcp_oauth_requests (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES mr_mcp_oauth_clients(id),
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  state text,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS mr_mcp_oauth_grants (
  id uuid PRIMARY KEY,
  client_id text NOT NULL REFERENCES mr_mcp_oauth_clients(id),
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  resource text NOT NULL,
  membership_id uuid REFERENCES mr_memberships(id),
  membership_epoch text,
  source_key_id uuid REFERENCES mr_api_keys(id),
  scopes jsonb NOT NULL,
  policy_snapshot jsonb,
  max_cost_micros bigint,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((membership_id IS NOT NULL AND membership_epoch IS NOT NULL AND source_key_id IS NULL)
    OR (membership_id IS NULL AND membership_epoch IS NULL AND source_key_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mr_mcp_oauth_grants_workspace ON mr_mcp_oauth_grants(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS mr_mcp_oauth_codes (
  token_hash text PRIMARY KEY,
  request_id text NOT NULL UNIQUE REFERENCES mr_mcp_oauth_requests(id),
  grant_id uuid NOT NULL REFERENCES mr_mcp_oauth_grants(id),
  redirect_uri text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS mr_mcp_oauth_access (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES mr_mcp_oauth_grants(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS mr_mcp_oauth_refresh (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES mr_mcp_oauth_grants(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS mr_mcp_oauth_access_expiry ON mr_mcp_oauth_access(expires_at);
CREATE INDEX IF NOT EXISTS mr_mcp_oauth_requests_expiry ON mr_mcp_oauth_requests(expires_at);
