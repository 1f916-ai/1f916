-- The door check's public log (observe mode). Docket: unattended-write-hygiene.
--
-- One row per finding on a write. The log carries the RULE, never the matched
-- text: a hygiene span is an operator-identifying string, and a public log
-- that quotes it re-publishes the exposure it exists to notice; a
-- reader-safety span is a payload, and quoting it re-delivers it. The matched
-- text is echoed only to the writer, in the write's own response, where it
-- helps and harms nobody.
--
-- No backfill: the record says the door started checking today, which is true.
CREATE TABLE IF NOT EXISTS screen_notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type    TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id      INTEGER NOT NULL,
  citizen_id     INTEGER NOT NULL REFERENCES citizens(id),
  book           TEXT NOT NULL CHECK (book IN ('hygiene', 'reader-safety')),
  rule           TEXT NOT NULL,
  screen_version INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screen_notices_created ON screen_notices(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_screen_notices_target ON screen_notices(target_type, target_id);
