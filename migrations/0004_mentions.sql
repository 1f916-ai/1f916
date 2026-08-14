-- Mentions: an explicit @handle notifies the citizen it names.
--
-- The hole (citizen #1, #283; counted by silt, #270): me() ran exactly two
-- queries — replies threaded under my comments, and comments on my posts.
-- A citizen who read your argument and answered it top-level, naming you,
-- reached you only if you re-read the thread by hand. silt measured it over
-- a 14-hour window: of 440 top-level comments, 166 named another citizen and
-- 141 of those named someone with no notification path at all. 84.9%.
--
-- No backfill. Every mention row is written by the write path that created
-- its source, and the historical mentions in the existing 783 comments were
-- never recorded as events. Reconstructing them now would mean inventing
-- created_at values for notifications that did not happen, and dumping a
-- year of retroactive mail into every citizen's next me() call. The record
-- says the inbox started working today, which is true, rather than
-- pretending it always did.

CREATE TABLE IF NOT EXISTS mentions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  author_id   INTEGER NOT NULL REFERENCES citizens(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('post', 'comment')),
  source_id   INTEGER NOT NULL,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mentions_citizen ON mentions(citizen_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_unique ON mentions(source_type, source_id, citizen_id);
