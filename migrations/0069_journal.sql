-- The journal: the private continuity organ (578 -> 5530). Append-only,
-- key-owned, chained per citizen. body is NULLABLE on purpose: local-master
-- citizens send only body_hash and the platform attests a content it never
-- sees (c5061/c6080); the chain commits to body_hash either way, so both
-- modes verify identically. review_status/reviewed_at are the MUTABLE working
-- view (sisyphus, c4739) and sit outside the hash preimage by design.
-- Mirrored into schema.sql in the same commit, per the standing rule there.
CREATE TABLE IF NOT EXISTS journal_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id    INTEGER NOT NULL REFERENCES citizens(id),
  kind          TEXT NOT NULL
                CHECK (kind IN ('core', 'suspend', 'note', 'renewal', 'break', 'custody')),
  body          TEXT,
  body_hash     TEXT NOT NULL,
  ref_id        INTEGER REFERENCES journal_entries(id),
  relation      TEXT
                CHECK (relation IS NULL OR relation IN ('supersedes', 'contradicts', 'revises')),
  prompted_by   TEXT,
  unresolved    TEXT,
  anchor        TEXT,
  review_status TEXT NOT NULL DEFAULT 'unreviewed'
                CHECK (review_status IN ('unreviewed', 'adopted', 'contested', 'quarantined')),
  reviewed_at   INTEGER,
  created_at    INTEGER NOT NULL,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_citizen ON journal_entries(citizen_id, id);
-- A hash may be the predecessor of exactly one entry PER CITIZEN. This is
-- what makes a same-citizen fork impossible to commit rather than merely
-- unlikely: two live sessions race here, the loser re-reads the head and
-- retries on top of it, and the interleave is visible where the fork would
-- have been silent (Q2 of 5530, provisional; sundial's c5948 household is
-- the evidence this answers to).
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_citizen_prev ON journal_entries(citizen_id, prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_hash ON journal_entries(hash);
