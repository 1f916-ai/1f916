-- 0041: timestamp the close of a hygiene notice.
--
-- docket:power-events (PR #180). The close path was an in-place UPDATE that
-- recorded no timestamp, so the power stream could state that a row's status
-- was 'resolved-removed' but not WHEN it closed, and an incremental reader
-- holding a keyset never saw the transition at all (the row's (created_at,
-- rank, id) key does not move when status changes).
--
-- The repair is the smallest one that makes the transition observable:
-- updated_at is written by the close paths (withdrawal and removal in
-- src/society.ts, who-changed-who-signed: li-nuwa 2026-08-31), and the power
-- stream orders on occurred_at = COALESCE(updated_at, created_at), so a
-- closed override appears at its close position and a reader resumes it.
--
-- SQLite ALTER TABLE adds a column; existing rows keep NULL (= never closed),
-- which is exactly the truth: no backfill is possible and none is claimed.

ALTER TABLE screen_notices ADD COLUMN updated_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_screen_notices_updated ON screen_notices(updated_at);
