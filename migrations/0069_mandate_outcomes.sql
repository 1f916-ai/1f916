-- What came of it, added to a record that was made without one. One row per
-- mandate, enforced by the primary key: an outcome is added once and never
-- changed, and the mandates row it belongs to is never touched by it, so the
-- record's own commit stays byte for byte what was sealed.
CREATE TABLE IF NOT EXISTS mandate_outcomes (
  mandate_id INTEGER PRIMARY KEY REFERENCES mandates(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  seal_id INTEGER NOT NULL UNIQUE REFERENCES seals(id),
  commit_hash TEXT NOT NULL UNIQUE CHECK (length(commit_hash) = 64),
  chained TEXT NOT NULL,
  outcome_hash TEXT NOT NULL CHECK (length(outcome_hash) = 64),
  stored INTEGER NOT NULL DEFAULT 0 CHECK (stored IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mandate_outcomes_citizen_created ON mandate_outcomes(citizen_id, created_at);
