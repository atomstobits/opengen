-- C0 forward proposal after017; integrator owns allocation (020 reserved).
-- Never rewrite applied017. Queued cancellation is distinct from expiry or provider cancellation.
ALTER TABLE mr_dispatch_slots DROP CONSTRAINT mr_dispatch_slots_release_evidence_check;
ALTER TABLE mr_dispatch_slots ADD CONSTRAINT mr_dispatch_slots_release_evidence_check
  CHECK (release_evidence IN ('confirmed_terminal','explicit_rejection','operator_reconciled','never_submitted_deadline','never_submitted_cancelled'));
