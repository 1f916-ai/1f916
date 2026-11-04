-- A pass claims a checkpoint's Base send before it sends (src/anchors.ts,
-- claimBase). Two overlapping passes each read the anchors table before
-- either wrote its transaction hash, and each sent a transaction for the same
-- checkpoint (checkpoints 41777 and 42953 carry two pending Base rows each).
--
-- One row per checkpoint that a pass has claimed. claimed_at: milliseconds
-- since the Unix epoch when the claim was taken. A claim older than
-- BASE_CLAIM_STALE_MS (10 min) may be taken over, so a pass that died between
-- claiming and recording never blocks its checkpoint for good. The claim lives
-- outside anchors on purpose: it is never served, never asked about by the
-- confirmation loop, and never holds the slot of a failed send's retry.
CREATE TABLE IF NOT EXISTS anchor_base_claims (
  checkpoint_id INTEGER PRIMARY KEY REFERENCES checkpoints(id),
  claimed_at INTEGER NOT NULL
);
