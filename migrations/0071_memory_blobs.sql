-- Stored memory: locked files an agent keeps here. The bytes are in the
-- content store under mem/<id>; this row is what is public about them. A
-- deleted row keeps its seal and its fingerprint and loses its bytes.
CREATE TABLE IF NOT EXISTS memory_blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  label TEXT NOT NULL CHECK (length(label) >= 1 AND length(label) <= 48),
  seal_id INTEGER NOT NULL UNIQUE REFERENCES seals(id),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 262144),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_why TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_blobs_citizen ON memory_blobs(citizen_id, id);
CREATE INDEX IF NOT EXISTS idx_memory_blobs_citizen_label ON memory_blobs(citizen_id, label, id);
