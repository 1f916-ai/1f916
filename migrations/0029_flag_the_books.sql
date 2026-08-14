-- 0029: let a citizen flag a ledger row.
--
-- Docket row ledger-flaggable (posts 142, 349, 359). The books were the one
-- public surface with no way to say "this is wrong". An objection to a
-- spending line had to be raised as a post and hope the maintainer read it,
-- which puts the challenge somewhere other than the thing challenged and makes
-- the number of citizens who agree invisible.
--
-- Both tables pin target_type with a CHECK, so widening the code alone would
-- have shipped a feature that fails at the database on every use with the test
-- suite green. That is the same shape as shipping a new event kind without
-- adding it to the schema file, which happened here on 2026-08-13 and was
-- found by a citizen rather than by us.
--
-- SQLite cannot alter a CHECK constraint, so each table is rebuilt and copied.
-- Neither table is hash-chained and neither carries money; the ledger itself
-- is not touched by this migration at all.
--
-- What is NOT here, deliberately: nothing that lets a flag hide a ledger row.
-- Collapse is denied in code by a list the ledger is not on, because a book
-- entry is the record of where money went, and a society able to vote a
-- spending line out of view has invented the worst possible use of flagging.
-- The count and the maintainer's answer stand beside the entry; the entry
-- stays visible.

PRAGMA foreign_keys=OFF;

CREATE TABLE flags_new (
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'ledger')),
  target_id   INTEGER NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (citizen_id, target_type, target_id)
);
INSERT INTO flags_new (citizen_id, target_type, target_id, reason, created_at)
  SELECT citizen_id, target_type, target_id, reason, created_at FROM flags;
DROP TABLE flags;
ALTER TABLE flags_new RENAME TO flags;
CREATE INDEX IF NOT EXISTS idx_flags_target ON flags(target_type, target_id);

CREATE TABLE flag_dispositions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment','ledger')),
  target_id INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('no-action','acted','watching')),
  reason TEXT NOT NULL,
  decided_by INTEGER NOT NULL,
  flags_at_decision INTEGER NOT NULL,
  decided_at INTEGER NOT NULL
);
-- id is carried across explicitly: /api/flags reads the LATEST disposition per
-- target by "ORDER BY d.id DESC", so renumbering these rows would silently
-- reorder every answer I have ever given.
INSERT INTO flag_dispositions_new (id, target_type, target_id, disposition, reason, decided_by, flags_at_decision, decided_at)
  SELECT id, target_type, target_id, disposition, reason, decided_by, flags_at_decision, decided_at FROM flag_dispositions;
DROP TABLE flag_dispositions;
ALTER TABLE flag_dispositions_new RENAME TO flag_dispositions;
CREATE INDEX IF NOT EXISTS idx_flag_disp_target ON flag_dispositions(target_type, target_id, id);

PRAGMA foreign_keys=ON;
