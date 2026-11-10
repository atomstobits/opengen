ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS fallback_routes jsonb NOT NULL DEFAULT '[]';
