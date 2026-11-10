-- B2 UNNUMBERED PROPOSAL. Integration allocates a forward migration and loader.
-- This is B2-only schema (core slot023). B3 later adds mandate FK in024.
-- No existing key/grant gains a capability;
-- no old workspace receives a policy row or an active recharge mandate.
CREATE TABLE mr_billing_owners (
  workspace_id text PRIMARY KEY REFERENCES mr_workspaces(id),
  membership_id uuid NOT NULL REFERENCES mr_memberships(id),
  membership_epoch text NOT NULL,
  authority_version integer NOT NULL CHECK(authority_version > 0),
  processor_environment_id text NOT NULL CHECK (length(processor_environment_id) BETWEEN 1 AND 120), -- B3 slot024 adds the registry FK.
  livemode boolean NOT NULL,
  rails jsonb NOT NULL CHECK(jsonb_typeof(rails)='object' AND rails ? 'allowsEnabled' AND jsonb_typeof(rails->'allowsEnabled')='boolean'),
  consent_reference text NOT NULL CHECK(length(consent_reference) BETWEEN 1 AND 200),
  approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 1 AND 200),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE mr_billing_policies (
  workspace_id text PRIMARY KEY REFERENCES mr_workspaces(id),
  enabled boolean NOT NULL DEFAULT false,
  threshold_micros bigint NOT NULL CHECK (threshold_micros BETWEEN 0 AND 1000000000000),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 500 AND 100000),
  monthly_cap_cents integer NOT NULL CHECK (monthly_cap_cents BETWEEN 500 AND 10000000 AND monthly_cap_cents >= amount_cents),
  max_attempts_per_month integer NOT NULL CHECK (max_attempts_per_month BETWEEN 1 AND 10000),
  cooldown_seconds integer NOT NULL CHECK (cooldown_seconds BETWEEN 60 AND 2678400),
  failure_limit integer NOT NULL CHECK (failure_limit BETWEEN 1 AND 100),
  mandate_id uuid, -- B3 migration adds FK; transaction validates ownership/environment.
  owner_authority_version integer NOT NULL CHECK(owner_authority_version > 0),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT enabled OR mandate_id IS NOT NULL)
);
-- Worker lookup is bounded by its own workspace scheduling/claim query.
CREATE INDEX mr_billing_policies_enabled ON mr_billing_policies(workspace_id) WHERE enabled;

CREATE TABLE mr_billing_delegations (
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  target_kind text NOT NULL CHECK (target_kind IN ('key','grant')),
  target_id uuid NOT NULL,
  owner_authority_version integer NOT NULL CHECK(owner_authority_version > 0),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions)='array' AND jsonb_array_length(permissions) BETWEEN 1 AND 2 AND permissions <@ '["billing:read","billing:manage"]'::jsonb),
  rails jsonb NOT NULL CHECK (jsonb_typeof(rails)='object'),
  version integer NOT NULL CHECK (version > 0),
  consent_reference text NOT NULL CHECK (length(consent_reference) BETWEEN 1 AND 200),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,target_kind,target_id)
);
-- No token, secret, raw payment/provider payload or request-supplied actor stored.
CREATE TABLE mr_billing_policy_audit (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES mr_workspaces(id),
  actor jsonb NOT NULL CHECK(jsonb_typeof(actor)='object'),
  operation text NOT NULL CHECK(operation IN ('policy.updated','delegation.updated','delegation.revoked','owner.approved')),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  consent_reference text,
  delegation jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mr_billing_policy_audit_history ON mr_billing_policy_audit(workspace_id,created_at DESC,id DESC);
