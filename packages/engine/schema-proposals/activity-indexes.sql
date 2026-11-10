-- UNNUMBERED C7 Activity index proposal; integration owns slot018 + migration loader.
-- Apply after C5 attribution + metadata columns exist. Never infer missing attribution.
-- Pair key/project query predicates with direct columns, not to_jsonb(whole_row).
CREATE INDEX IF NOT EXISTS mr_jobs_activity_cursor
  ON mr_jobs(workspace_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS mr_jobs_activity_model
  ON mr_jobs(workspace_id,(input->>'modelId'),created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS mr_jobs_activity_provider
  ON mr_jobs(workspace_id,(deployment_snapshot->>'providerId'),created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS mr_jobs_activity_deployment
  ON mr_jobs(workspace_id,(deployment_snapshot->>'id'),created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS mr_jobs_activity_region
  ON mr_jobs(workspace_id,(deployment_snapshot->>'endpointRegion'),created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS mr_jobs_activity_operation
  ON mr_jobs(workspace_id,(input->>'operation'),created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS mr_jobs_activity_status
  ON mr_jobs(workspace_id,status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS mr_jobs_activity_key
  ON mr_jobs(workspace_id,(attribution->>'keyId'),created_at DESC,id DESC)
  WHERE attribution->>'keyId' IS NOT NULL;
CREATE INDEX IF NOT EXISTS mr_jobs_activity_project
  ON mr_jobs(workspace_id,(metadata->>'project'),created_at DESC,id DESC)
  WHERE metadata->>'project' IS NOT NULL;
-- Page rows reconcile ledger amounts without a tenant-wide ledger scan. Existing
-- unique(job_id,kind) remains the deduplication authority; this is a read index.
CREATE INDEX IF NOT EXISTS mr_ledger_activity_job
  ON mr_ledger(workspace_id,job_id) INCLUDE(kind,amount_micros,available_delta_micros,reserved_delta_micros)
  WHERE job_id IS NOT NULL;
