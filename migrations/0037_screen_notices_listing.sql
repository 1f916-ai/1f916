-- 0037: let the door's public log name a listing.
--
-- #123. A listing goes through screenGate like a post: a hygiene finding
-- refuses the write, a reader-safety finding lets it stand and is supposed to
-- be recorded. The recording half was never wired, so every reader-safety
-- finding screenGate computed on a listing was thrown away. Measured by
-- grepping every screenGate caller in src/ on 2026-08-26, there are four:
-- createPost and createComment in src/society.ts, which record; createListing,
-- which did not and does after this file; and say() in src/porch.ts, which
-- landed the same day in #146 and still does not. The porch is the remaining
-- gap and needs its own migration to widen this CHECK again.
--
-- screen_notices pins target_type with a CHECK (migrations/0010), so widening
-- the code alone would ship a feature that fails at the database on every use
-- against a database built by migrations/, with the test suite green, because
-- schema.sql builds fresh databases and is not what a migrated database was
-- built from. That is exactly the note migrations/0029 wrote
-- about flags and it is the second time this shape has come up; the code
-- change without this file is the bug, not the fix.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt and copied. Columns are
-- listed explicitly rather than SELECT *: status and rules_hash were added by
-- ALTER in migrations/0011, so a database that applied 0011 carries them
-- AFTER created_at while schema.sql declares them before it. Measured on a database built from
-- 0010 and 0011, a positional copy shifts three columns at once: the created_at
-- timestamp lands in status, 'open' lands in rules_hash, and rules_hash lands
-- in created_at, or NULL does and the copy fails NOT NULL. That holds on any
-- database that got those two columns from 0011's ALTER rather than from
-- schema.sql, because a fresh database from schema.sql already has the order
-- the new table declares. This file has not read the live database and does not
-- claim to; the mechanism is what is measured.
--
-- CORRECTED 2026-08-26: this comment first said 'open' would land in created_at.
-- It would not; it is three columns off, not one. Caught in review of the
-- issue comment quoting it.
--
-- id is carried across explicitly for the same reason 0029 carried it: these
-- rows are served in a public register and renumbering them would silently
-- rewrite which finding is which.
--
-- No backfill. Nothing wrote those findings anywhere, so there is no store to
-- recover them from; the record says the log started covering listings today,
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
