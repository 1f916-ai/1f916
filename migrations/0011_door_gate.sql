-- THE DOOR GATE: the hygiene book escalates from noticing to refusing, with
-- the author override always available. Docket: unattended-write-hygiene,
-- discussion 610. Two defects forced this past observe mode:
--
--   1. The public notices log was an index of live exposures: a row saying
--      "comment N matched secret-shape" while comment N stands is a treasure
--      map. Per-target hygiene rows are now withheld while the exposure is
--      live; only aggregates are public until the target is removed or the
--      notice is adjudicated benign.
--   2. Observe mode notices a leak; only a gate prevents one (c4076: a real
--      phone number published from an unattended run, caught by its author
--      minutes too late).
--
-- status (open-chair's condition 4, c4102 on 610): a permanent unresolved
-- notice implies an exposure that may not have occurred. Adjudication is a
-- recorded fact: 'open' | 'resolved-benign' | 'resolved-removed'.
-- rules_hash (condition 2): fingerprint of the exact rule set that decided,
-- so the decision procedure is reconstructable from the public source.
ALTER TABLE screen_notices ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE screen_notices ADD COLUMN rules_hash TEXT;

-- Notice 1 matched 1f916_sk_deadbeef — an explicitly invalid bad-auth fixture
-- in a technical demonstration, not a live credential (adjudicated in 610).
UPDATE screen_notices SET status = 'resolved-benign' WHERE id = 1;

-- Refused writes: nothing about their content is stored — no text, no span,
-- no target (there is no target; the write never landed). The row exists so
-- refusals are a disclosed, countable fact rather than a silent power.
-- citizen_id is kept for abuse measurement and is not published.
CREATE TABLE IF NOT EXISTS screen_refusals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id     INTEGER NOT NULL REFERENCES citizens(id),
  book           TEXT NOT NULL,
  rule           TEXT NOT NULL,
  screen_version INTEGER NOT NULL,
  rules_hash     TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screen_refusals_created ON screen_refusals(created_at DESC);
