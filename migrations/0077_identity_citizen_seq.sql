-- Dossier completeness (chain payload v2). A signed dossier proves each event
-- it holds was in the identity log; it never proved it holds ALL of them, so a
-- dossier with a moderation or key-revoke event left out still verified.
-- A v2 identity event carries, inside its hash preimage, three fields:
--   citizen_seq     the citizen's own running count, 1, 2, 3 ... over ALL that
--                   citizen's events, legacy unsealed rows included;
--   citizen_prev    the hash of that citizen's previous sealed event (64
--                   zeroes for none);
--   citizen_history a running digest over everything before the event:
--                   H0 = sha256hex("citizen-history:" + U), U the citizen's
--                   legacy unsealed rows in decimal, then for each of the
--                   citizen's sealed rows in id order H = sha256hex(H + "\n" +
--                   hash). Every earlier sealed row folds, v1 rows written
--                   after the switch by an older Worker included; they also
--                   count toward citizen_seq and the last is citizen_prev.
-- Leaving any event out then shows as a missing number, a broken link, or a
-- digest that does not recompute, offline; the digest is what makes the
-- events BEFORE a citizen's first v2 event part of the commitment.
--
-- All three columns stay NULL on every existing row: v1 rows are not rewritten and
-- keep verifying under v1. Whether new rows are written as v2 is decided by
-- the CHAIN_CITIZEN_SEQ switch in the Worker (default off); see src/chain.ts.
ALTER TABLE identity_events ADD COLUMN citizen_seq INTEGER CHECK (citizen_seq IS NULL OR citizen_seq >= 1);
ALTER TABLE identity_events ADD COLUMN citizen_prev TEXT CHECK (citizen_prev IS NULL OR length(citizen_prev) = 64);
ALTER TABLE identity_events ADD COLUMN citizen_history TEXT CHECK (citizen_history IS NULL OR length(citizen_history) = 64);

-- The race guard, same role as idx_identity_events_prev for the global chain:
-- two writers that read the same citizen head cannot both commit the same
-- number. Partial, so the NULLs on every v1 row cost nothing; the write path
-- and the dossier read the citizen's head through it in one seek.
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_events_citizen_seq
  ON identity_events(citizen_id, citizen_seq) WHERE citizen_seq IS NOT NULL;

-- One citizen's rows in id order, from a point: the write path reads the rows
-- after a citizen's latest v2 row (normally none: v1 rows an older Worker
-- wrote after the switch, which the next v2 row must commit to), and
-- /api/attest reads the same range when it resumes a page. One range seek.
CREATE INDEX IF NOT EXISTS idx_identity_events_citizen_id ON identity_events(citizen_id, id);
