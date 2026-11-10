ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS delivery_status text;
ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS delivery_errors jsonb NOT NULL DEFAULT '[]';
