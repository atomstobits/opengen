-- Forward migration 035: Allow 'published-tariff' costStatus on fee-bearing opaque
-- verified-delivery settlements while requiring persisted fee_cost_evidence.
-- Preserves 001..034 immutability and all transactional money/fee guards.
-- Per docs/OPERATIONS.md, schema upgrades run during a maintenance window with
-- admission and worker stopped; NOT VALID + VALIDATE CONSTRAINT separates metadata
-- replacement from row validation.

ALTER TABLE mr_jobs
  DROP CONSTRAINT IF EXISTS mr_jobs_fee_settlement_shape,
  DROP CONSTRAINT IF EXISTS mr_jobs_fee_evidence_shape,
  ADD CONSTRAINT mr_jobs_fee_settlement_shape CHECK (
    fee_settlement IS NULL OR (
      fee_admission IS NOT NULL
      AND settled_micros IS NOT NULL
      AND jsonb_typeof(fee_settlement) = 'object'
      AND fee_settlement ? 'customerTotalMicros'
      AND fee_settlement->'customerTotalMicros' = to_jsonb(settled_micros)
      AND settled_micros BETWEEN 0 AND reserved_micros
      AND fee_settlement->>'costStatus' IN ('verified', 'published-tariff', 'no-upstream-charge')
    ) IS TRUE
  ) NOT VALID,
  ADD CONSTRAINT mr_jobs_fee_evidence_shape CHECK (
    (
      (fee_cost_evidence IS NOT NULL)
      = (COALESCE(fee_settlement->>'costStatus', '') IN ('verified', 'published-tariff'))
    )
    AND (fee_cost_evidence IS NULL OR jsonb_typeof(fee_cost_evidence) = 'object')
  ) NOT VALID;

ALTER TABLE mr_jobs VALIDATE CONSTRAINT mr_jobs_fee_settlement_shape;
ALTER TABLE mr_jobs VALIDATE CONSTRAINT mr_jobs_fee_evidence_shape;
