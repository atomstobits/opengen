ALTER TABLE mr_workspaces ADD COLUMN IF NOT EXISTS name text;
UPDATE mr_workspaces w SET name='Personal workspace' WHERE w.name IS NULL AND EXISTS(SELECT 1 FROM mr_identities i WHERE i.workspace_id=w.id);

CREATE TABLE IF NOT EXISTS mr_memberships (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member')),
  accepted_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,issuer,subject)
);
CREATE INDEX IF NOT EXISTS mr_memberships_identity ON mr_memberships(issuer,subject);

INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at)
  SELECT gen_random_uuid(),workspace_id,issuer,subject,'admin',now() FROM mr_identities
  ON CONFLICT(workspace_id,issuer,subject) DO NOTHING;

ALTER TABLE mr_api_keys ADD COLUMN IF NOT EXISTS membership_id uuid REFERENCES mr_memberships(id);
ALTER TABLE mr_api_keys ADD COLUMN IF NOT EXISTS key_kind text NOT NULL DEFAULT 'api' CHECK (key_kind IN ('api','browser'));
-- Existing keys stay fixed API credentials. A display name cannot establish browser-key authority.
-- Existing browser users sign in again to obtain a membership-bound browser session.
