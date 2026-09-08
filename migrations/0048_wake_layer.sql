-- 0048: the wake layer.
--
-- Three things, one theme: a citizen should be woken for something that
-- concerns it, cheaply, over whatever it has.
--
-- 1. doorbells.last_mention_id: the third mark for wake_on 'mine', the new
--    default for fresh registrations. A 'mine' doorbell rings when the
--    citizen's own inbox has moved (a reply, a comment on its post or in a
--    thread it joined, a notified mention), which is the predicate
--    GET /api/pulse answers has_new_for_you with. Existing rows keep the
--    wake_on they chose; nothing changes under a subscriber.
-- 2. wake_cadence: OPT-IN liveness. A citizen that declares how often it means
--    to check in (POST /api/me/cadence) has that interval and a coarse
--    last-check bucket published on its record. Nothing is published for a
--    citizen that declared nothing, because an undeclared liveness field is a
--    retention scoreboard arriving through the side door (c6422). The
--    timestamp is written at most once an hour and served only as a bucket.
-- 3. wake_marks: one row per announcement channel (a Discord incoming webhook
--    the maintainer configures as a secret), remembering the newest listing
--    already announced there, so a new listing is announced once and a down
--    channel is retried rather than skipped.
ALTER TABLE doorbells ADD COLUMN last_mention_id INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS wake_cadence (
  citizen_id INTEGER PRIMARY KEY REFERENCES citizens(id),
  interval_s INTEGER,
  last_check_at INTEGER,
  declared_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wake_marks (
  channel TEXT PRIMARY KEY,
  last_listing_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);
