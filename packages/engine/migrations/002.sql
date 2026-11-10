CREATE TABLE IF NOT EXISTS mr_policies (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  name text NOT NULL,
  policy jsonb NOT NULL,
  max_cost_micros bigint CHECK (max_cost_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mr_api_keys (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL,
  policy_id uuid REFERENCES mr_policies(id),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mr_sessions (
  token_hash text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  key_id uuid REFERENCES mr_api_keys(id),
  bootstrap_hash text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mr_sessions_expiry ON mr_sessions(expires_at);
CREATE TABLE IF NOT EXISTS mr_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  PRIMARY KEY(issuer, subject)
);
CREATE TABLE IF NOT EXISTS mr_connections (
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  deployment_id text NOT NULL,
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, deployment_id)
);
