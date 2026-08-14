-- Protocol P2: signed Merkle checkpoints over the sealed chains. One row per
-- (log, tree_size): the registry's own signature over its tree head, computed
-- hourly in the cron. The witness records these outside our failure domain;
-- inclusion + consistency proofs against a witnessed checkpoint make
-- "append-only" a theorem instead of a promise.
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log TEXT NOT NULL CHECK (log IN ('identity_events','ledger')),
  tree_size INTEGER NOT NULL,
  root TEXT NOT NULL,
  sig TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(log, tree_size)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_log ON checkpoints(log, id DESC);
