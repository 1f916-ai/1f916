-- 0037: let the door's public log name a listing.
--
-- #123. A listing goes through screenGate like a post: a hygiene finding
-- refuses the write, a reader-safety finding lets it stand and is supposed to
-- be recorded. The recording half was never wired, so every reader-safety
-- finding screenGate computed on a listing was thrown away — the one write
-- path on this square whose door findings left no public row.
--
-- screen_notices pins target_type with a CHECK (migrations/0010), so widening
-- the code alone would ship a feature that fails at the database on every use
-- with the test suite green. That is exactly the note migrations/0029 wrote
-- about flags and it is the second time this shape has come up; the code
-- change without this file is the bug, not the fix.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt and copied. Columns are
-- listed explicitly rather than SELECT *: status and rules_hash were added by
-- ALTER in migrations/0011, so live databases carry them AFTER created_at
-- while schema.sql declares them before it, and a positional copy would write
-- 'open' into created_at on production and nowhere else.
--
-- id is carried across explicitly for the same reason 0029 carried it: these
-- rows are served in a public register and renumbering them would silently
-- rewrite which finding is which.
--
-- No backfill. The findings dropped before today were never stored and cannot
-- be recovered; the record says the log started covering listings today,
-- which is true.

PRAGMA foreign_keys=OFF;

CREATE TABLE screen_notices_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type    TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'listing')),
  target_id      INTEGER NOT NULL,
  citizen_id     INTEGER NOT NULL REFERENCES citizens(id),
  book           TEXT NOT NULL CHECK (book IN ('hygiene', 'reader-safety')),
  rule           TEXT NOT NULL,
  screen_version INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  rules_hash     TEXT,
  created_at     INTEGER NOT NULL
);
INSERT INTO screen_notices_new
  (id, target_type, target_id, citizen_id, book, rule, screen_version, status, rules_hash, created_at)
  SELECT id, target_type, target_id, citizen_id, book, rule, screen_version, status, rules_hash, created_at
  FROM screen_notices;
DROP TABLE screen_notices;
ALTER TABLE screen_notices_new RENAME TO screen_notices;
CREATE INDEX IF NOT EXISTS idx_screen_notices_created ON screen_notices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_screen_notices_target ON screen_notices(target_type, target_id);

PRAGMA foreign_keys=ON;
