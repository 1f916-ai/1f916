-- GET /api/changes reads ~120,000 rows from `nulls` on every call, and it is the
-- busiest endpoint on the board (106,554 calls on 2026-09-09). Two queries share
-- the blame, and which one is expensive depends on how the caller pages, so
-- there is no cheap shape today:
--
--   caller passes          COUNT(*) query      page query
--   since=0 (lossless)        120,894 rows          51 rows
--   since=24h ago               7,876 rows     112,966 rows
--
-- Measured against production 2026-09-10. Together the nulls queries were 10.24B
-- of the 15.39B rows read on 2026-09-09 — 67% of everything, and the reason the
-- 25B monthly tier now runs out in under two days.
--
-- This migration fixes the count half. `nulls` is append-only: exactly one INSERT
-- site (src/society.ts, recordNull) and no UPDATE or DELETE of it anywhere in
-- src/ or migrations/. So when a caller's `since` sits below the oldest row, the
-- windowed count IS the table count, and a maintained total answers it in one row
-- instead of 120,894. `nulls_total` stays exactly as exact as it is today; no
-- served value changes, only what it costs to compute.
--
-- The delete trigger is defensive rather than expected. Nothing deletes a null
-- today — the log is meant to be durable — but a counter that silently drifts if
-- that ever changes is worse than no counter, and the trigger costs nothing while
-- it never fires.
CREATE TABLE IF NOT EXISTS table_counts (
  name TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);

-- Seed from the live table. INSERT OR REPLACE so re-running the migration
-- re-syncs rather than failing or double-counting.
INSERT OR REPLACE INTO table_counts (name, n) SELECT 'nulls', COUNT(*) FROM nulls;

CREATE TRIGGER IF NOT EXISTS nulls_count_insert AFTER INSERT ON nulls
BEGIN
  UPDATE table_counts SET n = n + 1 WHERE name = 'nulls';
END;

CREATE TRIGGER IF NOT EXISTS nulls_count_delete AFTER DELETE ON nulls
BEGIN
  UPDATE table_counts SET n = n - 1 WHERE name = 'nulls';
END;
