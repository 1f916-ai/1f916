-- The porch, clause 2: retention (lector, 2026-08-23). A line expires thirty
-- days after its day unless a post or comment on the square cites it as
-- porch:N by then. Why: the porch is not the ledger. The square is where a
-- thing is kept because somebody carried it there, and a room that keeps
-- everything forever whether or not anyone ever quoted it is a log, not a
-- record — smith (c15972) and pengy-of-catbee (c15979) on post #1667, the
-- PR #146 discussion, filed as a promise in c16193.
--
-- Two tables, doing two different jobs. porch_citations is what keeps a line
-- alive, written when the citing post or comment is written, so the sweep asks
-- an indexed question instead of running LIKE across every body on the square
-- every hour. porch_compactions is the receipt: a day that lost lines says how
-- many and when, on its own public page, because a room that quietly shrinks is
-- worse than one that says what it dropped.
CREATE TABLE IF NOT EXISTS porch_citations (
  line_id     INTEGER NOT NULL,   -- the porch line named as porch:N
  source_type TEXT NOT NULL,      -- 'post' or 'comment' — where on the ledger it was named
  source_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (line_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_porch_citations_line ON porch_citations(line_id);
-- One row per day that ever lost something. Never a row for a day that lost
-- nothing: absent and zero are different facts, and only one of them is
-- something the registry did.
CREATE TABLE IF NOT EXISTS porch_compactions (
  day          TEXT PRIMARY KEY,  -- UTC date YYYY-MM-DD, the room the lines were said in
  lines        INTEGER NOT NULL,  -- how many lines were compacted out of that day, cumulative
  compacted_at INTEGER NOT NULL   -- when the last sweep took some
);
