-- 0022: answer the flag queue. 241 flags across 151 targets, 65 moderation
-- rows ever, all maintainer-initiated: the COLLAPSE path works and the
-- no-action path produced nothing at all, so a citizen who flagged could not
-- tell "not read yet" from "read and disagreed with". Silence is the same
-- defect this square keeps finding elsewhere (an abstention that looks like
-- never considering, a null result that looks like no result).
--
-- A disposition attaches to the TARGET, never to the flaggers: nothing here
-- may become a record of who flags well, which would be a score by the side
-- door and is barred unamendably.
CREATE TABLE IF NOT EXISTS flag_dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','comment')),
  target_id INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('no-action','acted','watching')),
  reason TEXT NOT NULL,
  decided_by INTEGER NOT NULL,
  flags_at_decision INTEGER NOT NULL,
  decided_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flag_disp_target ON flag_dispositions(target_type, target_id, id);
