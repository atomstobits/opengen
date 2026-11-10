-- Actual active-policy human assent only; identity/membership creation is not assent.
-- Independent issuer/subject identity permits writing before or after account provisioning.
-- Bounded UTF-8 identity/version bytes keep the immutable composite key within btree limits.
CREATE TABLE mr_terms_receipts (
  issuer text NOT NULL CHECK (
    octet_length(issuer) BETWEEN 1 AND 1024
    AND issuer ~ '^https?://' AND issuer !~ '[[:space:][:cntrl:]]'
  ),
  subject text NOT NULL CHECK (
    octet_length(subject) BETWEEN 1 AND 512
    AND subject !~ '^[[:space:]]*$' AND subject !~ '[[:cntrl:]]'
  ),
  policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  notice_version text NOT NULL DEFAULT 'human-terms-continue-v1'
    CHECK (notice_version='human-terms-continue-v1'),
  action text NOT NULL DEFAULT 'continue' CHECK (action='continue'),
  method text NOT NULL DEFAULT 'oidc-verified' CHECK (method='oidc-verified'),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(issuer,subject,policy_version)
);

CREATE FUNCTION mr_terms_receipts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'terms_receipt_immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER mr_terms_receipts_no_update_delete BEFORE UPDATE OR DELETE ON mr_terms_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION mr_terms_receipts_immutable();
CREATE TRIGGER mr_terms_receipts_no_truncate BEFORE TRUNCATE ON mr_terms_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION mr_terms_receipts_immutable();
