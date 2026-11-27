-- Forward migration 036: Durable shared storage for Email OTP challenges and rate limits,
-- plus Terms receipt verification-method support for GitHub OAuth and Email OTP sign-in.
-- Preserves 001..035 immutability and existing historical 'oidc-verified' Terms receipts.

CREATE TABLE mr_email_otp_challenges (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 128 AND id ~ '^[A-Za-z0-9_-]+$'),
  email_hash text NOT NULL CHECK (email_hash ~ '^[a-f0-9]{64}$'),
  salt text NOT NULL CHECK (salt ~ '^[a-f0-9]{32}$'),
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= max_attempts),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at))
);

CREATE INDEX mr_email_otp_challenges_expires_idx
  ON mr_email_otp_challenges (expires_at);

CREATE TABLE mr_email_otp_rate_limits (
  scope text NOT NULL CHECK (scope IN ('send_email', 'send_client', 'verify_client')),
  subject_hash text NOT NULL CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
  window_start bigint NOT NULL CHECK (window_start >= 0),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(updated_at)),
  PRIMARY KEY (scope, subject_hash)
);

CREATE INDEX mr_email_otp_rate_limits_updated_idx
  ON mr_email_otp_rate_limits (updated_at);

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'mr_terms_receipts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%method%'
  LOOP
    EXECUTE format('ALTER TABLE mr_terms_receipts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE mr_terms_receipts
  ADD CONSTRAINT mr_terms_receipts_method_check
  CHECK (method IN ('oidc-verified', 'github-oauth-verified', 'email-otp-verified'));
