-- UNNUMBERED C7 draft; integrator owns slot allocation and migration loader.
CREATE TABLE IF NOT EXISTS mr_notification_preferences (
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  membership_id uuid NOT NULL REFERENCES mr_memberships(id),
  in_app boolean NOT NULL DEFAULT true,
  event_types jsonb NOT NULL DEFAULT '["alert.triggered","alert.resolved"]'
    CHECK (jsonb_typeof(event_types)='array' AND event_types <@ '["alert.triggered","alert.resolved"]'::jsonb),
  PRIMARY KEY(workspace_id,membership_id)
);
CREATE TABLE IF NOT EXISTS mr_notification_reads (
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  membership_id uuid NOT NULL REFERENCES mr_memberships(id),
  event_id uuid NOT NULL REFERENCES mr_events(id),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,membership_id,event_id)
);
CREATE INDEX IF NOT EXISTS mr_events_notification_cursor ON mr_events(workspace_id,created_at DESC,id DESC)
  WHERE type IN ('alert.triggered','alert.resolved');
CREATE INDEX IF NOT EXISTS mr_webhook_subscription_status ON mr_webhook_deliveries(subscription_id,status);
