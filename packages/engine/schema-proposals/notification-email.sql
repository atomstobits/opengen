-- Unnumbered optional C7 email proposal; C0 owns reserved021 and the loader.
-- No address or opt-in is inferred for legacy members.
CREATE UNIQUE INDEX IF NOT EXISTS mr_memberships_email_owner ON mr_memberships(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS mr_events_email_owner ON mr_events(workspace_id,id);
ALTER TABLE mr_notification_preferences ADD COLUMN email_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE mr_notification_preferences ADD COLUMN email_opt_in_at timestamptz;
ALTER TABLE mr_notification_preferences ADD COLUMN email_recipient_revision integer;
CREATE TABLE mr_notification_email_recipients (
  workspace_id text NOT NULL,
  membership_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254 AND email !~ '[[:cntrl:]]'),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,membership_id),
  FOREIGN KEY(workspace_id,membership_id) REFERENCES mr_memberships(workspace_id,id)
);
CREATE TABLE mr_notification_email_deliveries (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  membership_id uuid NOT NULL,
  event_id uuid NOT NULL,
  recipient_revision integer NOT NULL CHECK(recipient_revision>0),
  recipient_email text NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('alert.triggered','alert.resolved')),
  app_url text NOT NULL,
  transport_id text NOT NULL CHECK(transport_id ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','unknown','sent','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,membership_id),
  FOREIGN KEY(workspace_id,event_id) REFERENCES mr_events(workspace_id,id),
  FOREIGN KEY(workspace_id,membership_id) REFERENCES mr_memberships(workspace_id,id)
);
CREATE INDEX mr_notification_email_due ON mr_notification_email_deliveries(status,next_attempt_at,lease_until);
CREATE INDEX mr_notification_email_member ON mr_notification_email_deliveries(workspace_id,membership_id,status);
CREATE INDEX mr_events_email_scan ON mr_events(created_at,id) WHERE type IN ('alert.triggered','alert.resolved');
