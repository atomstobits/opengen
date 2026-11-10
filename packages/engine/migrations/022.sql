ALTER TABLE mr_jobs
  ADD COLUMN fee_admission jsonb,
  ADD COLUMN fee_settlement jsonb,
  ADD COLUMN fee_cost_evidence jsonb,
  ADD CONSTRAINT mr_jobs_fee_admission_shape CHECK (
    fee_admission IS NULL OR (
      jsonb_typeof(fee_admission) = 'object'
      AND fee_admission ? 'schemaVersion'
      AND fee_admission->'schemaVersion' = '1'::jsonb
      AND jsonb_typeof(fee_admission->'snapshot') = 'object'
      AND COALESCE(input->>'billing', 'managed') = 'managed'
      AND fee_admission->'customerCeilingMicros' = to_jsonb(reserved_micros)
      AND reserved_micros BETWEEN 0 AND 9007199254740991
      AND ((settled_micros IS NULL) = (fee_settlement IS NULL))
    ) IS TRUE
  ),
  ADD CONSTRAINT mr_jobs_fee_settlement_shape CHECK (
    fee_settlement IS NULL OR (
      fee_admission IS NOT NULL
      AND settled_micros IS NOT NULL
      AND jsonb_typeof(fee_settlement) = 'object'
      AND fee_settlement ? 'customerTotalMicros'
      AND fee_settlement->'customerTotalMicros' = to_jsonb(settled_micros)
      AND settled_micros BETWEEN 0 AND reserved_micros
      AND fee_settlement->>'costStatus' IN ('verified', 'no-upstream-charge')
    ) IS TRUE
  ),
  ADD CONSTRAINT mr_jobs_fee_evidence_shape CHECK (
    ((fee_cost_evidence IS NOT NULL) = (COALESCE(fee_settlement->>'costStatus', '') = 'verified'))
    AND (fee_cost_evidence IS NULL OR jsonb_typeof(fee_cost_evidence) = 'object')
  );
