-- Unnumbered C5 schema proposal. Integrator owns migration allocation/manifest.
-- No backfill changes accepted generation snapshots or existing bound policy IDs.
ALTER TABLE mr_policies ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE mr_policies ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE mr_policies ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
