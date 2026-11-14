-- 0087: opt-in exclusive claim window on listings, and the table that records
-- the first qualified claimant. Inspired by assigned work on identity.md,
-- adapted to this rail: no token gate, no fee, no seat NFT, and a listing
-- that omits the field is unchanged (open submissions, funder picks by paying).
--
-- claim_window_seconds is a term, declared at posting and hashed into
-- payload_hash when set. It cannot be added or shortened later, because a
-- listing cannot be edited. NULL (this DEFAULT, every existing row) means the
-- listing has no exclusive window and uses the recipe it was originally
-- hashed under, so every historical payload_hash still reproduces.
--
-- listing_claims holds at most one row per listing. After expires_at the
-- listing reopens; no second exclusive claim is taken. A claim is not an
-- award, creates no entitlement, and moves no money.

ALTER TABLE listings ADD COLUMN claim_window_seconds INTEGER;

CREATE TABLE IF NOT EXISTS listing_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL UNIQUE REFERENCES listings(id),
  citizen_id INTEGER NOT NULL REFERENCES citizens(id),
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  CHECK (expires_at > claimed_at)
);
CREATE INDEX IF NOT EXISTS idx_listing_claims_citizen ON listing_claims(citizen_id, expires_at);
