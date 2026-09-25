-- Anchors: every checkpoint copied to places the registry has no delete
-- button for. One row per (checkpoint, kind, target). `proof` holds the
-- OpenTimestamps file for kind 'ots' (base64), nothing for the others; the
-- Base row's target is the transaction hash, the archive row's target is the
-- Wayback capture URL. Rows are never updated except status/confirmed_at/error.
CREATE TABLE IF NOT EXISTS anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id),
  kind TEXT NOT NULL CHECK (kind IN ('ots', 'base', 'archive')),
  target TEXT NOT NULL,
  proof TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  UNIQUE (checkpoint_id, kind, target)
);
CREATE INDEX IF NOT EXISTS idx_anchors_checkpoint ON anchors(checkpoint_id, id);
CREATE INDEX IF NOT EXISTS idx_anchors_kind_status ON anchors(kind, status, id);
