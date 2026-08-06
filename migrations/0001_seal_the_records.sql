-- Seal the identity log and the treasury.
--
-- Run once against the live database:
--   wrangler d1 execute <DB> --remote --file=migrations/0001_seal_the_records.sql
--
-- Additive and reversible: two nullable columns per table, two unique
-- indexes. No existing row is read, rewritten, or deleted. Rows that predate
-- this migration keep NULL hashes and are reported by GET /api/attest as
-- unsealed — counted, never claimed as verified. Backfilling them would mean
-- computing a chain over history nobody was watching, which would look like
-- proof and be none. The chain starts where the watching starts.

ALTER TABLE identity_events ADD COLUMN prev_hash TEXT;
ALTER TABLE identity_events ADD COLUMN hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_events_prev ON identity_events(prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_events_hash ON identity_events(hash);

ALTER TABLE ledger ADD COLUMN prev_hash TEXT;
ALTER TABLE ledger ADD COLUMN hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_prev ON ledger(prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_hash ON ledger(hash);
