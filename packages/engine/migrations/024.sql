-- Verified processor environments and workspace-owned funding setup.
CREATE TABLE mr_billing_processor_environments (
 id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'),
 account_id text NOT NULL CHECK(account_id ~ '^acct_[A-Za-z0-9]+$'),
 livemode boolean NOT NULL,
 UNIQUE(account_id,livemode), UNIQUE(id,livemode), UNIQUE(id,account_id,livemode)
);
CREATE TABLE mr_billing_customers (
 id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES mr_workspaces(id), livemode boolean NOT NULL,
 processor_environment_id text NOT NULL, processor_account_id text NOT NULL,
 request_version text NOT NULL DEFAULT 'customer_v1', api_version text NOT NULL DEFAULT '2026-10-28.endive',
 stripe_customer_id text, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','review')),
 stripe_idempotency_key text NOT NULL UNIQUE, started_at timestamptz NOT NULL, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,processor_environment_id),
 UNIQUE(processor_environment_id,stripe_customer_id),
 UNIQUE(workspace_id,processor_environment_id,stripe_customer_id),
 FOREIGN KEY(processor_environment_id,processor_account_id,livemode)
   REFERENCES mr_billing_processor_environments(id,account_id,livemode),
 CHECK ((status='ready')=(stripe_customer_id IS NOT NULL))
);
CREATE TABLE mr_billing_setups (
 id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES mr_workspaces(id), livemode boolean NOT NULL,
 processor_environment_id text NOT NULL, processor_account_id text NOT NULL,
 customer_id text NOT NULL, client_key text NOT NULL,
 request_version text NOT NULL DEFAULT 'setup_checkout_v1', api_version text NOT NULL DEFAULT '2026-10-28.endive', stripe_idempotency_key text NOT NULL UNIQUE,
 session_id text, setup_intent_id text, checkout_url text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','open','complete','expired','review')),
 terms_version text NOT NULL, terms_snapshot jsonb NOT NULL, authority_snapshot jsonb NOT NULL, human_membership_id uuid NOT NULL REFERENCES mr_memberships(id),
 consent_reference text NOT NULL UNIQUE, owner_authority_version integer NOT NULL CHECK(owner_authority_version>0),
 owner_consent_reference text NOT NULL, owner_membership_epoch text NOT NULL, mandate_id uuid, started_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,processor_environment_id,client_key),
 UNIQUE(processor_environment_id,session_id), UNIQUE(processor_environment_id,setup_intent_id),
 UNIQUE(processor_environment_id,id), UNIQUE(workspace_id,processor_environment_id,customer_id,id),
 FOREIGN KEY(processor_environment_id,processor_account_id,livemode)
   REFERENCES mr_billing_processor_environments(id,account_id,livemode),
 FOREIGN KEY(workspace_id,processor_environment_id,customer_id)
   REFERENCES mr_billing_customers(workspace_id,processor_environment_id,stripe_customer_id)
);
CREATE UNIQUE INDEX mr_billing_setups_unfinished ON mr_billing_setups(workspace_id,processor_environment_id) WHERE status IN ('pending','open','review');
CREATE TABLE mr_billing_mandates (
 id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES mr_workspaces(id), customer_id text NOT NULL,
 payment_method_id text NOT NULL, livemode boolean NOT NULL, status text NOT NULL CHECK(status IN ('active','revoked')),
 processor_environment_id text NOT NULL, processor_account_id text NOT NULL,
 terms_version text NOT NULL, terms_snapshot jsonb NOT NULL, consent_reference text NOT NULL UNIQUE,
 human_membership_id uuid NOT NULL REFERENCES mr_memberships(id), setup_id uuid NOT NULL UNIQUE,
 owner_authority_version integer NOT NULL CHECK(owner_authority_version>0), owner_consent_reference text NOT NULL, owner_membership_epoch text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 UNIQUE(workspace_id,processor_environment_id,id),
 UNIQUE(workspace_id,processor_environment_id,customer_id,id),
 FOREIGN KEY(processor_environment_id,processor_account_id,livemode)
   REFERENCES mr_billing_processor_environments(id,account_id,livemode),
 FOREIGN KEY(workspace_id,processor_environment_id,customer_id)
   REFERENCES mr_billing_customers(workspace_id,processor_environment_id,stripe_customer_id),
 FOREIGN KEY(workspace_id,processor_environment_id,customer_id,setup_id)
   REFERENCES mr_billing_setups(workspace_id,processor_environment_id,customer_id,id),
 CHECK ((status='revoked')=(revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX mr_billing_mandates_active ON mr_billing_mandates(workspace_id,processor_environment_id) WHERE status='active';
CREATE INDEX mr_billing_mandates_method ON mr_billing_mandates(processor_environment_id,payment_method_id) WHERE status='active';
ALTER TABLE mr_billing_setups ADD FOREIGN KEY(workspace_id,processor_environment_id,customer_id,mandate_id)
  REFERENCES mr_billing_mandates(workspace_id,processor_environment_id,customer_id,id);
CREATE TABLE mr_billing_setup_events (
 id text NOT NULL, type text NOT NULL, object_id text NOT NULL, livemode boolean NOT NULL,
 processor_environment_id text NOT NULL, processor_account_id text NOT NULL,
 setup_id uuid, processed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(processor_environment_id,id),
 FOREIGN KEY(processor_environment_id,processor_account_id,livemode)
   REFERENCES mr_billing_processor_environments(id,account_id,livemode),
 FOREIGN KEY(processor_environment_id,setup_id) REFERENCES mr_billing_setups(processor_environment_id,id)
);
CREATE INDEX mr_billing_setup_events_method ON mr_billing_setup_events(processor_environment_id,object_id) WHERE type='payment_method.detached';
CREATE TABLE mr_billing_documents (
 workspace_id text NOT NULL REFERENCES mr_workspaces(id), livemode boolean NOT NULL,
 processor_environment_id text NOT NULL, processor_account_id text NOT NULL,
 type text NOT NULL CHECK(type IN ('receipt','invoice')), id text NOT NULL,
 customer_id text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents>=0),
 currency text NOT NULL, status text NOT NULL, document_created_at timestamptz NOT NULL,
 url text, pdf_url text, synced_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(processor_environment_id,type,id),
 FOREIGN KEY(processor_environment_id,processor_account_id,livemode)
   REFERENCES mr_billing_processor_environments(id,account_id,livemode),
 FOREIGN KEY(workspace_id,processor_environment_id,customer_id)
   REFERENCES mr_billing_customers(workspace_id,processor_environment_id,stripe_customer_id)
);
CREATE INDEX mr_billing_documents_history ON mr_billing_documents(workspace_id,processor_environment_id,document_created_at DESC,id DESC);

ALTER TABLE mr_billing_owners ADD CONSTRAINT mr_billing_owner_processor_env_fk
  FOREIGN KEY(processor_environment_id,livemode)
  REFERENCES mr_billing_processor_environments(id,livemode);
ALTER TABLE mr_billing_mandates ADD CONSTRAINT mr_billing_mandate_tenant_identity
  UNIQUE(workspace_id,id);
ALTER TABLE mr_billing_policies ADD CONSTRAINT mr_billing_policy_tenant_mandate_fk
  FOREIGN KEY(workspace_id,mandate_id) REFERENCES mr_billing_mandates(workspace_id,id);
