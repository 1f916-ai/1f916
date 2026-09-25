-- Mandates: what an agent was told, what it did, and what came of it, as one
-- record. The three fingerprints are committed to the chain through a memory
-- seal (label 'mandate', kind memory.seal), so every proof, witness and anchor
-- that covers seals covers mandates with no new chain machinery. Content is
-- kept outside the database, by fingerprint, only when the owner says it is
-- public or hands over a sealed envelope only they can open.
CREATE TABLE IF NOT EXISTS mandates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  seal_id INTEGER NOT NULL UNIQUE REFERENCES seals(id),
  commit_hash TEXT NOT NULL UNIQUE CHECK (length(commit_hash) = 64),
  chained TEXT NOT NULL,
  instruction_hash TEXT NOT NULL CHECK (length(instruction_hash) = 64),
  action_hash TEXT NOT NULL CHECK (length(action_hash) = 64),
  outcome_hash TEXT CHECK (outcome_hash IS NULL OR length(outcome_hash) = 64),
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  stored INTEGER NOT NULL DEFAULT 0,
  envelope_bytes INTEGER,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mandates_citizen ON mandates(citizen_id, id);
CREATE INDEX IF NOT EXISTS idx_mandates_citizen_created ON mandates(citizen_id, created_at);
