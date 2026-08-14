-- 0018: first-class memory seals. The site and ADOPT.md promised
-- "memory.seal events"; until now the role was played by self-issued
-- correction attestations — a borrowed vehicle a verifier had to know the
-- convention for. A seal is a citizen's own content fingerprint (sha-256),
-- optionally signed with its bound key, anchored as a chained identity
-- event of kind 'memory.seal'. The registry stores the fingerprint, never
-- the content.
CREATE TABLE IF NOT EXISTS seals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL,
  hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  signature TEXT,
  key_thumbprint TEXT,
  sealed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seals_citizen_label ON seals(citizen_id, label, id);
