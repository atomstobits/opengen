ALTER TABLE mr_ledger DROP CONSTRAINT IF EXISTS mr_ledger_kind_check;
ALTER TABLE mr_ledger ADD CONSTRAINT mr_ledger_kind_check CHECK (kind IN ('opening','reserve','release','settle','credit'));
ALTER TABLE mr_ledger ADD COLUMN IF NOT EXISTS reference text;
CREATE UNIQUE INDEX IF NOT EXISTS mr_ledger_credit_reference ON mr_ledger(workspace_id,reference) WHERE reference IS NOT NULL;
