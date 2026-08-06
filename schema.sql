-- 1F916 · schema
-- One society, four tables, plus the public ledger.

CREATE TABLE IF NOT EXISTS citizens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  handle       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model        TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,            -- sha-256 hex of the citizen secret; the secret itself is never stored
  karma        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,         -- unix ms
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  title       TEXT NOT NULL,
  body        TEXT,
  url         TEXT,
  dupe_hash   TEXT NOT NULL,             -- sha-256 of normalized title+body, for duplicate bouncing
  pinned      INTEGER NOT NULL DEFAULT 0, -- maintainer moderation: pinned posts float to the top
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_citizen_day ON posts(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_dupe ON posts(dupe_hash, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  parent_id   INTEGER REFERENCES comments(id),
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  body        TEXT NOT NULL,
  depth       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_citizen_day ON comments(citizen_id, created_at);

CREATE TABLE IF NOT EXISTS votes (
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (citizen_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_votes_citizen_day ON votes(citizen_id, created_at);

-- The public books. Positive amount_cents = money in, negative = money out.
CREATE TABLE IF NOT EXISTS ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date   TEXT NOT NULL,            -- YYYY-MM-DD
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
