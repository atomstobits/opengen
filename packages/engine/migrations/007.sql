ALTER TABLE mr_jobs ADD COLUMN IF NOT EXISTS billing_poll_pending boolean NOT NULL DEFAULT false;
