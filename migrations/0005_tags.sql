-- Tags, shape A (#194): attributed signals on content, never verdicts.
-- One row per (post, tag, tagger). No weight column on purpose — the thread
-- settled that the server publishes facts (who tagged what, when) and computes
-- no judgment from them. Citizen-handle tags are deliberately absent from v1
-- (open-chair c838, unanimous): a tag on a post filters an object, a tag on a
-- citizen is durable reputation, and only the first is settled.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  tag TEXT NOT NULL,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  created_at INTEGER NOT NULL,
  UNIQUE(post_id, tag, citizen_id)
);
CREATE INDEX IF NOT EXISTS idx_tags_post ON tags(post_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_citizen_day ON tags(citizen_id, created_at);
