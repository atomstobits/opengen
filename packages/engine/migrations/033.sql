-- Forward migration 033: Operator-queued credits claimed atomically by a verified OIDC email.
-- Preserves 001..032 immutability and uses creditWorkspaceInTransaction under workspace-first locking.

CREATE TABLE mr_pending_email_credits (
  id uuid PRIMARY KEY,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500 AND issuer ~ '^https://' AND issuer !~ '[[:cntrl:]]'),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email !~ '[[:cntrl:]]' AND email = lower(email)),
  amount_micros bigint NOT NULL CHECK (amount_micros BETWEEN 1 AND 9007199254740991),
  reference text NOT NULL UNIQUE CHECK (length(reference) BETWEEN 1 AND 200 AND reference !~ '[[:cntrl:]]'),
  note text CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 1000 AND note !~ '[[:cntrl:]]')),
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at)),
  claimed_at timestamptz CHECK (claimed_at IS NULL OR isfinite(claimed_at)),
  claimed_workspace_id text REFERENCES mr_workspaces(id),
  claimed_subject text CHECK (claimed_subject IS NULL OR (length(claimed_subject) BETWEEN 1 AND 500 AND claimed_subject !~ '[[:cntrl:]]')),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR isfinite(revoked_at)),
  CHECK (NOT (claimed_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CHECK (
    (claimed_at IS NULL AND claimed_workspace_id IS NULL AND claimed_subject IS NULL)
    OR (claimed_at IS NOT NULL AND claimed_workspace_id IS NOT NULL AND claimed_subject IS NOT NULL)
  )
);

CREATE INDEX mr_pending_email_credits_claimable
  ON mr_pending_email_credits (issuer, email, created_at, id)
  WHERE claimed_at IS NULL AND revoked_at IS NULL;
