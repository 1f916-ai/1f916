-- The nulls census, counted from maintained buckets instead of by reading the
-- table.
--
-- Migration 0051 fixed ONE regime of this: when a caller's `since` sits below
-- the oldest row, the windowed count IS the table count, so `table_counts`
-- answers it in a single row. Every other regime still counts for real, and
-- those are the ones production actually pays for. Measured 2026-09-16, with
-- meta.rows_read from --remote:
--
--   SELECT COUNT(*) FROM nulls WHERE created_at > ?1              71,743 rows
--   SELECT COUNT(*) FROM nulls WHERE created_at > ?1 AND id > ?2  71,740 rows
--
-- Per call, on the busiest endpoint on the board. Together those two statements
-- were 6.7B rows/day. The nulls table is 189,839 rows and growing 11,000+ a day,
-- so this gets worse every day nobody touches it.
--
-- WHY BUCKETS AND NOT ARITHMETIC. Two cheaper designs were built and measured
-- and both are WRONG, and they are recorded here so they are not retried:
--
--   1. `remaining = n - (boundary - 1)`, using the gapless-id property (counter,
--      MAX(id) and COUNT(*) all agree at 189,797, MIN(id) = 1, so ids really are
--      gapless). The arithmetic over-counts by the rows sitting in the skew band
--      -- created_at is not monotonic in id, because recordNull binds a `now`
--      sampled when the request started. Measured: arithmetic 71,749, truth
--      71,745, correction 4. Exact only WITH the correction, and computing the
--      correction cost 118,087 rows -- more than the statement it replaces.
--   2. Bounding that correction to a 60s band, on the theory that every row
--      stamped at or below `since - margin` has a lower id than the boundary.
--      IT DOES NOT: banded correction 8, true correction 9. The boundary lemma
--      runs one way only (every row in the window has id >= boundary); the
--      converse is false, and one row proved it. A census built on it is quietly
--      wrong, which is worse than one that is slow.
--
-- Buckets have no such hole: they are keyed on created_at, the same column the
-- predicate filters, so no lemma about ids is involved at all. The count of a
-- window is the sum of the buckets it covers plus one partial bucket, and every
-- term is exact by construction.
--
-- COST, measured against production before building this: the partial bucket
-- (since -> end of its hour) reads 177 rows. A 7-day window spans 8 day buckets
-- and at most 24 hour buckets. So ~208 rows replaces 71,743, and unlike the
-- arithmetic it stays exact when the clock and the id order disagree.
--
-- WHY TWO SPANS. Hour buckets alone would need 169 rows for a 7-day window and
-- 8,760 for a year -- unbounded in the thing that always grows here, which is
-- exactly the class of defect this whole line of work exists to remove. Day
-- buckets alone cannot start mid-day without a partial covering up to 24 hours
-- of rows. Day + hour + a partial hour bounds any window at ~365 + 24 + one
-- hour's rows, and the hour rows are only ever read for the boundary day.
--
-- THE SAME STATEMENT THAT WOULD SILENTLY BREAK 0051 BREAKS THIS, so do not write
-- it: an `INSERT OR REPLACE INTO nulls` displacing an existing id fires the
-- insert trigger without the matching delete, because SQLite fires delete
-- triggers on a REPLACE only when `recursive_triggers` is on, and it is not. The
-- pre-deploy auditor reproduced that drift on 0051's counter on 2026-09-10.
-- nulls is written in exactly one place (recordNull, a plain single-row
-- INSERT ... RETURNING) and nothing updates or deletes it -- verified again
-- 2026-09-16: `INSERT INTO nulls` appears once in src/, and no UPDATE, DELETE or
-- REPLACE against the table exists anywhere in src/ or migrations/. If upsert
-- semantics are ever needed, adjust these buckets explicitly in the same
-- statement rather than trusting the triggers to notice.
--
-- The delete trigger is defensive rather than expected, for the same reason
-- 0051's is: nothing deletes a null today, and a counter that drifts silently if
-- that ever changes is worse than no counter at all.

CREATE TABLE IF NOT EXISTS nulls_buckets (
  -- 'day' or 'hour'. Two spans in one table rather than two tables, so the
  -- triggers below are one statement each per span and cannot fall out of step.
  span   TEXT    NOT NULL CHECK (span IN ('day', 'hour')),
  -- created_at / 86400000 for a day, / 3600000 for an hour. Integer division on
  -- the stored millisecond stamp: no timezone, no string formatting, and the
  -- same expression in the trigger, the seed and the reader.
  bucket INTEGER NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (span, bucket)
);

-- Seed from the live table. INSERT OR REPLACE so re-running the migration
-- re-syncs rather than failing or double-counting -- the same property 0051
-- relies on.
INSERT OR REPLACE INTO nulls_buckets (span, bucket, n)
  SELECT 'day', created_at / 86400000, COUNT(*) FROM nulls GROUP BY created_at / 86400000;
INSERT OR REPLACE INTO nulls_buckets (span, bucket, n)
  SELECT 'hour', created_at / 3600000, COUNT(*) FROM nulls GROUP BY created_at / 3600000;

CREATE TRIGGER IF NOT EXISTS nulls_buckets_insert AFTER INSERT ON nulls
BEGIN
  INSERT INTO nulls_buckets (span, bucket, n) VALUES ('day', NEW.created_at / 86400000, 1)
    ON CONFLICT (span, bucket) DO UPDATE SET n = n + 1;
  INSERT INTO nulls_buckets (span, bucket, n) VALUES ('hour', NEW.created_at / 3600000, 1)
    ON CONFLICT (span, bucket) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER IF NOT EXISTS nulls_buckets_delete AFTER DELETE ON nulls
BEGIN
  UPDATE nulls_buckets SET n = n - 1 WHERE span = 'day'  AND bucket = OLD.created_at / 86400000;
  UPDATE nulls_buckets SET n = n - 1 WHERE span = 'hour' AND bucket = OLD.created_at / 3600000;
END;
